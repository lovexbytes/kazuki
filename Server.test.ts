// Server test
// ===========
// `bun test Server.test.ts`. `./Server.ts <port>` alone serves the site
// (its prices only if it bills); with workers set, it is their
// supervisor, which only routes (a proxy in front sends each request to
// the worker it names).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";

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

// `./Server.ts <port>` on a fresh dir, with `env`: its answer to `path`,
// read whole, once it answers
async function server_get(port: number, env: Record<string, string>, path: string, headers?: HeadersInit): Promise<Response> {
  const dir = fs.mkdtempSync(os.tmpdir() + "/kazuki-server-");
  const site = "http://127.0.0.1:" + port;
  const proc = Bun.spawn([process.execPath, import.meta.dir + "/Server.ts", String(port)], {
    env    : { ...process.env, KAZUKI_DIR: dir, KAZUKI_SITE: site, ...env },
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

test("Server.ts alone serves the page", async () => {
  const res = await server_get(9461, {}, "/");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<title>");
});

test("the compiled terminal manages its local server separately from its TUI", async () => {
  const scratch = os.tmpdir() + "/";
  const dir = fs.mkdtempSync(scratch + "kazuki-terminal-");
  fs.mkdirSync(dir + "/home");
  const bin = dir + "/kazuki";
  const data = dir + "/data";
  const port = await unused_port();
  const site = "http://127.0.0.1:" + port;
  const env = { ...process.env, KAZUKI_DIR: data, KAZUKI_URL: "http://localhost:" + port, KAZUKI_SITE: site };
  let absent: Bun.Subprocess | undefined;
  let proc: Bun.Subprocess | undefined;
  let tui: Bun.Subprocess | undefined;
  let v6: Bun.Subprocess | undefined;
  let update: Bun.Subprocess | undefined;
  let pid: number | undefined;
  try {
    const build = Bun.spawnSync([process.execPath, "build", "--compile", import.meta.dir + "/Term.ts", "--outfile", bin], { cwd: import.meta.dir });
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
    const app = await fetch(site + "/app.js", { signal: AbortSignal.timeout(1000) });
    expect(app.status).toBe(200);
    expect((await app.text()).length).toBeGreaterThan(0);
    const install = await fetch(site + "/install.sh", { signal: AbortSignal.timeout(1000) });
    expect(install.status).toBe(200);
    const script = await install.text();
    expect(script).toContain("releases/latest");
    expect(script).not.toContain("example.invalid/install.sh");
    fs.mkdirSync(dir + "/fake");
    fs.writeFileSync(dir + "/fake/curl", "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    update = Bun.spawn([bin, "update"], { cwd: dir, env: { ...env, PATH: dir + "/fake" }, stdout: "ignore", stderr: "pipe" });
    const update_err = await new Response(update.stderr).text();
    await update.exited;
    expect(update.exitCode).toBe(7);
    expect(update_err).toContain("raw.githubusercontent.com/lovexbytes/kazuki/main/install.sh");
    tui = Bun.spawn([bin, "tui"], { cwd: dir, env, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    tui.stdin.write("/quit\n");
    await Promise.race([tui.exited, Bun.sleep(5000).then(() => { throw new Error("TUI did not exit"); })]);
    expect(tui.exitCode).toBe(0);
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
    let run = Bun.spawnSync(["sh", import.meta.dir + "/install.sh"], { env, stdout: "ignore", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const target = home + "/.local/bin/kazuki";
    expect(fs.readFileSync(target, "utf8")).toContain("fixture");
    fs.writeFileSync(target, "keep me\n", { mode: 0o755 });
    fs.writeFileSync(fixture + "/SHA256SUMS", `${"0".repeat(64)}  ${asset}\n`);
    run = Bun.spawnSync(["sh", import.meta.dir + "/install.sh"], { env, stdout: "ignore", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("keep me\n");
    run = Bun.spawnSync(["sh", import.meta.dir + "/install.sh"], { env: { ...env, LATEST: "https://github.com/lovexbytes/kazuki/releases" }, stdout: "ignore", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("no published release");
    expect(fs.readFileSync(target, "utf8")).toBe("keep me\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with workers, Server.ts routes to them", async () => {
  const res = await server_get(9471, { KAZUKI_WORKERS: "2" }, "/");
  expect(res.headers.get("x-kazuki-worker")).toMatch(/^127\.0\.0\.1:947[23]$/);
  expect(await res.text()).toBe("");
});

// The local server opens its fixed user without a session and rejects hosts
// or origins which could expose that unauthenticated chat.
test("the local user needs no session and hostile origins are refused", async () => {
  expect(await (await server_get(9481, {}, "/api/me")).json()).toMatchObject({ id: "local", name: "local", bills: false });
  expect((await server_get(9484, {}, "/api/me", { host: "example.test" })).status).toBe(403);
  expect((await server_get(9485, {}, "/api/me", { origin: "http://evil.test" })).status).toBe(403);
  expect((await server_get(9482, {}, "/pricing")).status).toBe(404);
  expect((await server_get(9483, {}, "/terms.html")).status).toBe(404);
});

// a /model while the turn's call runs picks the next call's: the wait
// names the model the running one asked. Its own process, as config is
// read once a process (another test file's dir is not this one's)
const TURN = `
const { Chat } = await import(${JSON.stringify(import.meta.dir + "/Server.ts")});
const { AskAI } = await import(${JSON.stringify(import.meta.dir + "/AskAI.ts")});
const { Cloud } = await import(${JSON.stringify(import.meta.dir + "/Cloud.ts")});
Chat.cloud = Cloud.open(() => {});
const chat = Chat.open({ id: "u1", name: "a@b.c" });
AskAI.ask = (ask, on) => AskAI.tie(on, ask.bill, () => {}, () => {})[0];
Chat.take(chat, Chat.push(chat, null, "user", "hi"));
await Bun.sleep(10);
const model = chat.pick.model;
const waited = Chat.waits(chat);
const to = { ...chat.pick, model: model === "opus-5.5" ? "haiku-5.5" : "opus-5.5" };
const acted = await Chat.act(chat, "pick", { $: "pick", to }, "");
console.log(JSON.stringify({ model, waited, acted, picked: chat.pick.model, to: to.model, after: Chat.waits(chat) }));
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
  expect(out.acted).toEqual({});
  expect(out.picked).toBe(out.to);
  expect(out.after).toBe(out.model);
});
