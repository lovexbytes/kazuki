// Run
// ===
// The end-to-end run: `test/e2e/env.sh bun test/e2e/run.ts` (env.sh makes the clean,
// isolated environment). It starts the mock vendors (mock.ts) and a
// Kazuki server from source with preload.ts, drives it as a person would
// (the pipe client, the terminal app in tmux, the compiled executable),
// and checks what each saw and what the mock was asked. Everything lands
// in $E2E; nothing else is touched.
// It prints one line per check and exits 1 if any failed.

import * as fs from "node:fs";

const E2E    = process.env.E2E!;
const LOG    = process.env.E2E_LOG!;
const ROOT   = import.meta.dir + "/../..";
const SERVER = process.env.KAZUKI_URL!;
const MOCK   = process.env.E2E_MOCK!;
const PORT   = Number(new URL(SERVER).port);

if (!E2E || !process.env.KAZUKI_DIR?.startsWith(E2E) || PORT === 8788) {
  console.error("run: start me with test/e2e/env.sh (KAZUKI_DIR must be under $E2E, never port 8788)");
  process.exit(2);
}

const procs: Bun.Subprocess[] = [];
let failed = 0;

// Helpers
// =======

function check(name: string, ok: boolean, why = ""): void {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || why === "" ? "" : "\n     " + why.split("\n").join("\n     ")));
  failed += ok ? 0 : 1;
}

function asked(): any[] {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function start(name: string, cmd: string[]): Bun.Subprocess {
  const out = Bun.file(E2E + "/" + name + ".out");
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: out, stderr: out });
  procs.push(proc);
  return proc;
}

async function until(what: () => Promise<boolean> | boolean, ms = 10e3): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
    if (await what()) return true;
  }
  return false;
}

const up = (url: string) => fetch(url + "/api/me").then((r) => r.ok, () => false);

async function server_start(): Promise<Bun.Subprocess> {
  const proc = start("server", ["bun", "--preload", "./test/e2e/preload.ts", "src/cli.ts", "serve", String(PORT)]);
  check("server starts on " + SERVER, await until(() => up(SERVER)), fs.readFileSync(E2E + "/server.out", "utf8"));
  return proc;
}

// one pipe client run: the lines sent, what it printed (stdout+stderr)
async function say(lines: string[], ms = 60e3, env: Record<string, string | undefined> = process.env): Promise<string> {
  const proc = Bun.spawn(["bun", "src/cli.ts"], { cwd: ROOT, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(lines.join("\n") + "\n");
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), ms);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  await proc.exited;
  return out + err;
}

function sh(cmd: string[]): { ok: boolean; out: string; stdout: string } {
  const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString(), stdout: r.stdout.toString() };
}

// Scenarios
// =========

async function main(): Promise<void> {
  start("mock", ["bun", "test/e2e/mock.ts", new URL(MOCK).port]);
  check("mock starts", await until(() => fetch(MOCK + "/").then(() => true, () => false)));
  let server = await server_start();

  // the server's own route
  check("serves /api/me", (await fetch(SERVER + "/api/me")).ok);

  // Anthropic: a reply, a tool call run on this device
  let out = await say(["hello e2e"]);
  check("anthropic: a reply streams back", out.includes("pong anthropic: hello e2e"), out);
  let a = asked().filter((r) => r.path === "/v1/messages");
  check("anthropic: asked with the dummy key", a.length > 0 && a.every((r) => r.auth === "e2e-anthropic-dummy"), JSON.stringify(a.map((r) => r.auth)));
  out = await say(["RUN: echo e2e-anthropic-tool && pwd"]);
  check("anthropic: shell tool call shown", out.includes("→ shell echo e2e-anthropic-tool"), out);
  check("anthropic: tool result goes back to the model", out.includes("ran: e2e-anthropic-tool"), out);
  check("tool runs in the e2e work dir", fs.existsSync(process.env.KAZUKI_WORK + "/main"), process.env.KAZUKI_WORK + "/main missing");

  // the server's keys stay on the server: a job runs in its terminal's own
  // environment (machine.ts), so a terminal with no keys gives it none
  const keyless = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY")));
  out = await say(["RUN: echo keys=$(env | grep -c _API_KEY)"], 60e3, keyless);
  check("a job gets none of the server's keys", out.includes("ran: keys=0"), out);

  // a long message: the compactor (the provider's cheapest) summarizes it
  const before = asked().length;
  out = await say(["long " + "words to compact ".repeat(80)]);
  const compacted = await until(() => asked().slice(before).some((r) => r.body?.model === "claude-haiku-5-5"), 15e3);
  check("compactor runs on the cheapest model", compacted, JSON.stringify(asked().slice(before).map((r) => r.body?.model)));

  // OpenAI: pick a model of its, a reply, a tool call
  out = await say(["/model gpt-6-luna"]);
  out = await say(["hello openai"]);
  check("openai: a reply after /model", out.includes("pong openai: hello openai"), out);
  const o = asked().filter((r) => r.path === "/v1/responses");
  check("openai: Responses API asked with the dummy key", o.length > 0 && o.every((r) => r.auth === "Bearer e2e-openai-dummy"), JSON.stringify(o.map((r) => r.auth)));
  check("openai: asked for gpt-6-luna", o.some((r) => r.body?.model === "gpt-6-luna"), JSON.stringify(o.map((r) => r.body?.model)));
  out = await say(["RUN: echo e2e-openai-tool"]);
  check("openai: tool call and result", out.includes("→ shell echo e2e-openai-tool") && out.includes("ran: e2e-openai-tool"), out);

  // a restart keeps the chat: the next call's view has the old messages
  server.kill();
  await server.exited;
  check("server stops", !(await up(SERVER)));
  server = await server_start();
  let n = asked().length;
  out = await say(["after restart"]);
  const view = JSON.stringify(asked().slice(n).find((r) => r.path === "/v1/responses")?.body ?? {});
  check("after a restart: reply on the saved pick", out.includes("pong openai: after restart"), out);
  check("after a restart: the view holds the earlier chat", view.includes("hello e2e") && view.includes("hello openai"), view.slice(0, 400));

  // the terminal app in tmux, as a person uses it
  const tmux = (args: string[]) => sh(["tmux", "-L", "kazuki-e2e-" + PORT, ...args]);
  const pane = () => tmux(["capture-pane", "-p", "-t", "e2e"]).out;
  const keys = (...k: string[]) => tmux(["send-keys", "-t", "e2e", ...k]);
  const type = (text: string) => (tmux(["send-keys", "-t", "e2e", "-l", text]), keys("Enter"));
  const seen = (what: string | RegExp, ms = 20e3) => until(() => (typeof what === "string" ? pane().includes(what) : what.test(pane())), ms);
  const shot = (name: string) => fs.writeFileSync(E2E + "/tui-" + name + ".txt", pane());
  tmux(["kill-server"]);
  const env = ["HOME", "KAZUKI_DIR", "KAZUKI_WORK", "KAZUKI_URL", "KAZUKI_MODELS_FETCH", "PATH"].map((k) => k + "=" + JSON.stringify(process.env[k]));
  tmux(["new-session", "-d", "-s", "e2e", "-x", "140", "-y", "45", "env -i TERM=xterm-256color " + env.join(" ") + " bun src/cli.ts tui"]);
  check("tui: opens and draws the chat", await seen("pong openai: after restart", 15e3), pane());
  check("tui: the footer shows the pick", await seen("gpt-6-luna"), pane());

  type("hello from tui");
  check("tui: a typed message gets its reply", await seen("pong openai: hello from tui"), pane());

  // /help: a sheet over the page, closed by Esc
  type("/help");
  check("tui: /help opens a sheet of commands and keys", await seen(/Keys[\s\S]*Ctrl\+O|\/model/), pane());
  shot("help");
  // an Esc alone waits out the terminal's escape-sequence time first
  await Bun.sleep(300);
  keys("Escape");
  check("tui: Esc closes the sheet", await until(() => !pane().includes("─ Help ─"), 5e3), pane());
  await Bun.sleep(300);

  // the model picker (Ctrl+P), and /model with a name
  keys("C-p");
  check("tui: Ctrl+P lists the models", await seen(/sonnet-5\.5[\s\S]*haiku-5\.5|haiku-5\.5[\s\S]*sonnet-5\.5/, 10e3), pane());
  shot("picker");
  await Bun.sleep(300);
  keys("Escape");
  check("tui: Esc closes the picker", await until(() => !/sonnet-5\.5[\s\S]*haiku-5\.5/.test(pane()), 5e3), pane());
  await Bun.sleep(300);
  type("/model sonnet-5.5");
  check("tui: /model changes the footer", await seen("sonnet-5.5"), pane());
  n = asked().length;
  type("on sonnet");
  check("tui: the next turn runs on the model picked", await seen("pong anthropic: on sonnet") && asked().slice(n).some((r) => r.body?.model === "claude-sonnet-5-5"), JSON.stringify(asked().slice(n).map((r) => r.body?.model)));
  keys("S-Right");
  check("tui: Shift+Right steps to the next model", await until(() => !/sonnet-5\.5\s+medium/.test(pane().split("\n").filter((l) => l.includes("127.0.0.1:")).join("")), 5e3), pane());
  type("/model gpt-6-luna");
  check("tui: back on gpt-6-luna", await seen(/gpt-6-luna\s+medium/), pane());

  // a tool call while you watch: its card runs, then its folded output
  // opens whole with Ctrl+O
  type("RUN: sleep 2; seq 1 40");
  check("tui: a running tool call shows its card", await seen(/\$ (Shell )?sleep 2; seq 1 40/, 10e3), pane());
  check("tui: the tool's reply comes after it", await seen("ran: 1"), pane());
  const folded = pane();
  keys("C-o");
  check("tui: Ctrl+O opens the tool's output whole", await until(() => folded.includes("lines above") && !pane().includes("lines above"), 5e3), pane());
  shot("ctrl-o");
  keys("C-o");

  // /stop cuts a running tool: its shell dies, the next message works
  // its own length, so another run's sleep is never taken for it
  const nap = "sleep 45." + PORT;
  type("RUN: " + nap);
  await seen("sleep 45", 10e3);
  const sleeping = () => sh(["pgrep", "-f", "^" + nap.replace(".", "\\.") + "$"]).ok;
  check("tui: the long tool runs here", await until(sleeping, 5e3));
  type("/stop");
  check("tui: /stop kills the tool's process", await until(() => !sleeping(), 10e3));
  type("after stop");
  check("tui: a message after /stop gets its reply", await seen("pong openai: after stop"), pane());

  // the server restarts while the terminal is open: it links again
  server.kill();
  await server.exited;
  server = await server_start();
  type("after server restart");
  check("tui: reconnects after the server restarts", await seen("pong openai: after server restart", 30e3), pane());
  shot("end");

  // Ctrl+D on an empty input quits; the chat goes on without it
  keys("C-d");
  check("tui: Ctrl+D quits", await until(() => !tmux(["has-session", "-t", "e2e"]).ok, 5e3), pane());
  tmux(["kill-server"]);

  // a command piped as the first line applies, though it comes before the
  // view has the server's state
  await say(["/model haiku-5.5"], 30e3);
  n = asked().length;
  await say(["which model"]);
  check("pipe: a /command as the first piped line applies", asked().slice(n).some((r) => r.body?.model === "claude-haiku-5-5"), JSON.stringify(asked().slice(n).map((r) => r.body?.model)));


  // the compiled executable: builds, prints help, and works as a client
  const bin = E2E + "/kazuki";
  const built = sh(["bun", "scripts/build.ts", "--outfile", bin]);
  check("executable builds", built.ok, built.out);
  check("executable: help", sh([bin, "help"]).out.includes("Usage: kazuki"));
  const p = Bun.spawn([bin], { cwd: E2E, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write("RUN: echo e2e-binary-tool\n");
  p.stdin.end();
  const timer = setTimeout(() => p.kill(), 60e3);
  out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  clearTimeout(timer);
  check("executable: client runs a tool call", out.includes("ran: e2e-binary-tool"), out);

  // nothing escaped the mock
  const srv = fs.readFileSync(E2E + "/server.out", "utf8");
  check("no request left for a real host", !srv.includes("e2e: blocked"), srv.split("\n").filter((l) => l.includes("blocked")).join("\n"));
}

try {
  await main();
} catch (err: any) {
  check("run finished", false, String(err?.stack ?? err));
} finally {
  procs.forEach((p) => p.kill());
  console.log((failed === 0 ? "ALL PASS" : failed + " FAILED") + " (logs: " + E2E + ")");
  process.exit(failed === 0 ? 0 : 1);
}
