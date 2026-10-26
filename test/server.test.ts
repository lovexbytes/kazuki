// Server test
// ===========
// `bun test server.test.ts`. `./src/core/server.ts <port>` alone serves the chat;
// with workers set, it is their
// supervisor, which only routes (a proxy in front sends each request to
// the worker it names).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";

// a server starts only with a provider connected (plugin.ts): a fake key
process.env.ANTHROPIC_API_KEY ||= "test";
process.env.KAZUKI_MODELS_FETCH = "off";

async function unused_port(): Promise<number> {
  return await new Promise((done, fail) => {
    const listener = net.createServer();
    listener.once("error", fail);
    listener.listen(0, "127.0.0.1", () => {
      const port = (listener.address() as net.AddressInfo).port;
      listener.close((err) => err === undefined ? done(port) : fail(err));
    });
  });
}

// `./src/core/server.ts <port>` on a fresh dir, with `env`: its answer to `path`,
// read whole, once it answers
async function server_get(port: number, env: Record<string, string>, path: string, headers?: HeadersInit): Promise<Response> {
  const dir = fs.mkdtempSync(os.tmpdir() + "/kazuki-server-");
  const site = "http://127.0.0.1:" + port;
  const proc = Bun.spawn([process.execPath, import.meta.dir + "/../src/core/server.ts", String(port)], {
    env    : { ...process.env, KAZUKI_DIR: dir, ...env },
    stdout : "ignore",
    stderr : "inherit",
  });
  try {
    for (let k = 0; k < 100; k++) {
      const res = await fetch(site + path, { headers }).catch(() => null);
      if (res !== null) {
        return new Response(await res.text(), res);
      }
      await Bun.sleep(50);
    }
    throw new Error("no answer on " + site);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

test("server.ts alone serves no site", async () => {
  expect((await server_get(9461, {}, "/")).status).toBe(404);
});

test("the compiled terminal manages its local server separately from its TUI", async () => {
  const scratch = os.tmpdir() + "/";
  const dir = fs.mkdtempSync(scratch + "kazuki-terminal-");
  fs.mkdirSync(dir + "/home");
  const bin = dir + "/kazuki";
  const data = dir + "/data";
  const port = await unused_port();
  const site = "http://127.0.0.1:" + port;
  const env = { ...process.env, KAZUKI_DIR: data, KAZUKI_URL: "http://localhost:" + port };
  let absent: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let tui: Bun.Subprocess<"pipe", "ignore", "pipe"> | undefined;
  let v6: Bun.Subprocess | undefined;
  let update: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  let pid: number | undefined;
  try {
    const build = Bun.spawnSync([process.execPath, import.meta.dir + "/../scripts/build.ts", "--outfile", bin], { cwd: import.meta.dir + "/.." });
    expect(build.exitCode).toBe(0);
    absent = Bun.spawn([bin, "tui"], { cwd: dir, env, stdout: "ignore", stderr: "pipe" });
    const absent_err = await Promise.race([
      new Response(absent.stderr).text(),
      Bun.sleep(3000).then(() => { throw new Error("tui waited for an absent server"); }),
    ]);
    expect(absent.exitCode).not.toBe(0);
    expect(absent_err).toContain("local server");
    proc = Bun.spawn([bin, "server"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const out = await Promise.race([
      new Response(proc.stdout).text(),
      Bun.sleep(6000).then(() => { throw new Error("server command did not return"); }),
    ]);
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    pid = Number(out.match(/pid (\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    const me = await fetch(site + "/api/me", { signal: AbortSignal.timeout(1000) });
    expect(await me.json()).toMatchObject({ id: "local" });
    fs.mkdirSync(dir + "/fake");
    fs.writeFileSync(dir + "/fake/curl", "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    update = Bun.spawn([bin, "update"], { cwd: dir, env: { ...env, PATH: dir + "/fake" }, stdout: "ignore", stderr: "pipe" });
    const update_err = await new Response(update.stderr).text();
    await update.exited;
    expect(update.exitCode).toBe(7);
    expect(update_err).toContain("raw.githubusercontent.com/lovexbytes/kazuki/main/install.sh");
    tui = Bun.spawn([bin, "tui"], { cwd: dir, env, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    // a command as the first line waits for the chat it reads
    tui.stdin.write("/model\n/quit\n");
    // read as it runs: a full stderr pipe would block its exit
    const tui_err = new Response(tui.stderr).text();
    await Promise.race([tui.exited, Bun.sleep(5000).then(() => { throw new Error("TUI did not exit"); })]);
    expect(tui.exitCode).toBe(0);
    expect(await tui_err).toContain("/model <model> picks one.");
    expect((await fetch(site + "/api/me")).status).toBe(200);
    v6 = Bun.spawn([bin, "server"], { cwd: dir, env: { ...env, KAZUKI_URL: "http://[::1]:" + port }, stdout: "ignore", stderr: "pipe" });
    await Promise.race([v6.exited, Bun.sleep(3000).then(() => { throw new Error("IPv6 alias server command did not return"); })]);
    expect(v6.exitCode).toBe(0);
    expect((await fetch(site + "/api/me")).status).toBe(200);
  } finally {
    for (const child of [absent, proc, tui, v6, update]) {
      child?.kill();
      await child?.exited;
    }
    if (pid !== undefined) {
      process.kill(pid, "SIGTERM");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the installer accepts a verified release and preserves a target on checksum failure", () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/kazuki-install-");
  const fixture = dir + "/fixture";
  const home = dir + "/home";
  const fake = dir + "/fake";
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x64-baseline";
  const asset = `kazuki-${platform}-${arch}.tar.gz`;
  const archive = fixture + "/" + asset;
  try {
    fs.mkdirSync(fixture);
    fs.mkdirSync(fake);
    fs.writeFileSync(fixture + "/kazuki", "#!/bin/sh\necho fixture\n", { mode: 0o755 });
    expect(Bun.spawnSync(["tar", "-czf", archive, "kazuki"], { cwd: fixture }).exitCode).toBe(0);
    const digest = Bun.spawnSync(["shasum", "-a", "256", archive]).stdout.toString().split(/\s/)[0];
    fs.writeFileSync(fixture + "/SHA256SUMS", `${digest}  ${asset}\n`);
    fs.writeFileSync(fake + "/curl", `#!/bin/sh
out=
url=
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; *) url=$1; shift ;; esac
done
case "$url" in
  */releases/latest) printf '%s' "$LATEST" ;;
  */SHA256SUMS) cp "$FIXTURE/SHA256SUMS" "$out" ;;
  */*.tar.gz) cp "$ARCHIVE" "$out" ;;
  *) exit 7 ;;
esac
`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, TMPDIR: dir, PATH: fake + ":" + process.env.PATH, FIXTURE: fixture, ARCHIVE: archive, LATEST: "https://github.com/lovexbytes/kazuki/releases/tag/v1.0.138" };
    let run = Bun.spawnSync(["sh", import.meta.dir + "/../install.sh"], { env, stdout: "ignore", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const target = home + "/.local/bin/kazuki";
    expect(fs.readFileSync(target, "utf8")).toContain("fixture");
    fs.writeFileSync(target, "keep me\n", { mode: 0o755 });
    fs.writeFileSync(fixture + "/SHA256SUMS", `${"0".repeat(64)}  ${asset}\n`);
    run = Bun.spawnSync(["sh", import.meta.dir + "/../install.sh"], { env, stdout: "ignore", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("keep me\n");
    run = Bun.spawnSync(["sh", import.meta.dir + "/../install.sh"], { env: { ...env, LATEST: "https://github.com/lovexbytes/kazuki/releases" }, stdout: "ignore", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("no published release");
    expect(fs.readFileSync(target, "utf8")).toBe("keep me\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with workers, server.ts routes to them", async () => {
  const res = await server_get(9471, { KAZUKI_WORKERS: "2" }, "/");
  expect(res.headers.get("x-kazuki-worker")).toMatch(/^127\.0\.0\.1:947[23]$/);
  expect(await res.text()).toBe("");
});

// The local server opens its fixed user without a session and rejects hosts
// or origins which could expose that unauthenticated chat.
test("the local user needs no session and hostile origins are refused", async () => {
  expect(await (await server_get(9481, {}, "/api/me")).json()).toEqual({ id: "local", name: "local" });
  expect((await server_get(9484, {}, "/api/me", { host: "example.test" })).status).toBe(403);
  expect((await server_get(9485, {}, "/api/me", { origin: "http://evil.test" })).status).toBe(403);
  expect((await server_get(9482, {}, "/pricing")).status).toBe(404);
  expect((await server_get(9483, {}, "/terms.html")).status).toBe(404);
});

// a /model while the turn's call runs picks the next call's: the wait
// names the model the running one asked. Its own process, as config is
// read once a process (another test file's dir is not this one's)
const TURN = `
const { Chat, Views } = await import(${JSON.stringify(import.meta.dir + "/../src/core/server.ts")});
const { AskAI } = await import(${JSON.stringify(import.meta.dir + "/../src/ai/ask-ai.ts")});
const { Cloud } = await import(${JSON.stringify(import.meta.dir + "/../src/core/cloud.ts")});
const { Memory } = await import(${JSON.stringify(import.meta.dir + "/../src/core/memory.ts")});
const { Plugin } = await import(${JSON.stringify(import.meta.dir + "/../src/core/plugin.ts")});
Plugin.load();
Chat.cloud = Cloud.open(() => {});
const chat = Chat.open({ id: "u1", name: "a@b.c" });
AskAI.ask = (ask, on) => AskAI.tie(on, () => {}, () => {})[0];
Chat.take(chat, Chat.push(chat, null, "user", "hi"));
await Bun.sleep(10);
const model = chat.pick.model;
const waited = Views.waits(chat);
const to = { ...chat.pick, model: model === "opus-5.5" ? "haiku-5.5" : "opus-5.5" };
const acted = (await Views.act(chat, "pick", { $: "pick", to }, "")).ok;
console.log(JSON.stringify({ model, waited, acted, picked: chat.pick.model, to: to.model, after: Views.waits(chat) }));
process.exit(0);
`;

test("a turn's wait names the model it runs on, not one picked since", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/kazuki-server-");
  fs.writeFileSync(dir + "/turn.ts", TURN);
  const proc = Bun.spawn([process.execPath, dir + "/turn.ts"], { env: { ...process.env, KAZUKI_DIR: dir }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "{}");
  expect(out.model).toMatch(/\w/);
  expect(out.to).not.toBe(out.model);
  expect(out.waited).toBe(out.model);
  expect(out.acted).toBe(true);
  expect(out.picked).toBe(out.to);
  expect(out.after).toBe(out.model);
});

// an import paused stays paused once its chat opens again (import.json
// keeps why); one not paused (why null) goes on, though a chat loads
// paused (Memory.load). Each imports 2 messages too long to summarize
// with no call, its calls never ending, so it still runs at the reads
const RESUME = `
const fs = await import("node:fs");
const { Chat, Ingest, Views } = await import(${JSON.stringify(import.meta.dir + "/../src/core/server.ts")});
const { AskAI } = await import(${JSON.stringify(import.meta.dir + "/../src/ai/ask-ai.ts")});
const { Cloud } = await import(${JSON.stringify(import.meta.dir + "/../src/core/cloud.ts")});
const { Memory } = await import(${JSON.stringify(import.meta.dir + "/../src/core/memory.ts")});
const { Plugin } = await import(${JSON.stringify(import.meta.dir + "/../src/core/plugin.ts")});
Plugin.load();
Chat.cloud = Cloud.open(() => {});
AskAI.ask = (ask, on) => AskAI.tie(on, () => {}, () => {})[0];
const file = (id) => process.env.KAZUKI_DIR + "/users/" + id + "/import.json";
const why = (id) => JSON.parse(fs.readFileSync(file(id), "utf8")).why;
for (const [id, saved] of [["u1", "paused"], ["u2", null]]) {
  fs.mkdirSync(process.env.KAZUKI_DIR + "/users/" + id, { recursive: true });
  Memory.push(Memory.load(process.env.KAZUKI_DIR + "/users/" + id, () => ({})), [{ kind: "user", text: "hi ".repeat(9999) }, { kind: "assistant", text: "hello ".repeat(9999) }]);
  fs.writeFileSync(file(id), JSON.stringify({ a: 0, b: 2, said: 2, why: saved }));
}
const [held, goes] = [Chat.open({ id: "u1", name: "a" }), Chat.open({ id: "u2", name: "b" })];
await Bun.sleep(10);
const out = { held: Views.state(held).importing?.why, goes: Views.state(goes).importing?.why, paused: [held.mem.paused, goes.mem.paused] };
out.on = Ingest.go(held, true).ok;
out.went = why("u1");
out.off = Ingest.go(held, false).ok;
out.kept = why("u1");
console.log(JSON.stringify(out));
process.exit(0);
`;

test("an import's pause survives its chat opening again", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/kazuki-server-");
  fs.writeFileSync(dir + "/resume.ts", RESUME);
  const proc = Bun.spawn([process.execPath, dir + "/resume.ts"], { env: { ...process.env, KAZUKI_DIR: dir }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "{}");
  expect(out).toEqual({ held: "paused", goes: null, paused: [true, false], on: true, went: null, off: true, kept: "paused" });
});

test("a worker that dies starts again; one that fails in its place, after a pause", async () => {
  process.env.KAZUKI_DIR = fs.mkdtempSync(os.tmpdir() + "/kazuki-died-");
  const { Main } = await import("../src/core/server.ts");
  delete process.env.KAZUKI_DIR;
  const proc = (exitCode: number | null) => ({ exitCode, signalCode: null }) as Bun.Subprocess;
  const starts = { n: 0 };
  const again = () => starts.n++;
  const dead = proc(1);
  Main.died(0, 1, dead, dead, again);
  expect(starts.n).toBe(1);
  Main.died(0, 1, dead, proc(1), again);
  expect(starts.n).toBe(1);
  await Bun.sleep(5100);
  expect(starts.n).toBe(2);
  Main.died(0, 1, proc(null), proc(1), again);
  await Bun.sleep(5100);
  expect(starts.n).toBe(2);
}, 15e3);

// a chat open as its provider disconnects runs, from its next turn, on
// a model connected now, and says so
const MOVED = `
const { Chat } = await import(${JSON.stringify(import.meta.dir + "/../src/core/server.ts")});
const { Cloud } = await import(${JSON.stringify(import.meta.dir + "/../src/core/cloud.ts")});
const config = await import(${JSON.stringify(import.meta.dir + "/../src/config.ts")});
const { Plugin } = await import(${JSON.stringify(import.meta.dir + "/../src/core/plugin.ts")});
Plugin.load();
Chat.cloud = Cloud.open(() => {});
config.SECRETS.set("ANTHROPIC_API_KEY", "test");
config.SECRETS.set("OPENAI_API_KEY", "test");
const chat = Chat.open({ id: "u1", name: "a" });
const was = chat.pick.vendor;
config.SECRETS.set("ANTHROPIC_API_KEY", "");
Chat.repick(chat);
const notes = chat.mem.count;
console.log(JSON.stringify({ was, now: chat.pick.vendor, saved: chat.mem.pick.vendor, told: notes > 2 }));
process.exit(0);
`;

test("a chat whose provider disconnects runs on one connected now", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/kazuki-server-");
  fs.writeFileSync(dir + "/moved.ts", MOVED);
  const proc = Bun.spawn([process.execPath, dir + "/moved.ts"], { env: { ...process.env, KAZUKI_DIR: dir }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "{}");
  expect(out).toEqual({ was: "anthropic", now: "openai", saved: "openai", told: true });
});
