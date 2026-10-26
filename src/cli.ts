#!/usr/bin/env bun
// Term
// ====
// `kazuki`: the command. It starts the local server (server.ts, which it
// carries) or reaches one by its url, and opens the terminal's chat
// (src/tui/): a client of that server as the web is, and, while open, a
// device its tools reach (DEVICE). Every act of the site is a command
// there (/help). The agent's jobs run there (machine.ts) until done or
// halted; all they left running dies as this kazuki quits. From a pipe,
// each line is a message.
//
// One executable per platform (install.sh fetches it; scripts/build.ts makes
// it). `kazuki serve` runs the server it carries. The server: the url
// given, else $KAZUKI_URL, else the local server at 127.0.0.1:8788.
// `kazuki update` without a url uses this repository's installer.
//
// Usage: USAGE (`kazuki help` prints it).

import * as child from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { browse } from "./util/browse.ts";

// Constants
// =========

// this kazuki's version: each release ships one, a new one for every
// change to src/cli.ts or what it imports
const VERSION = "0.0.2";

const ARGS   = process.argv.slice(2);
const HELP   = ARGS.some((a) => ["help", "--help", "-h"].includes(a));
const ASKVER = ARGS.includes("version");
const UPDATE = ARGS.includes("update");
const SERVE  = ARGS.includes("serve");
const START  = ARGS.includes("server");
const TUI    = ARGS.includes("tui");
const SITE   = ARGS.includes("web");
const PORT   = SERVE ? ARGS.find((a) => /^\d+$/.test(a)) : undefined;
const SUB    = ARGS.includes("chatgpt");
const AUTH   = ARGS[0] === "auth";
const WORDS  = ["help", "--help", "-h", "version", "update", "serve", "server", "tui", "web", "chatgpt", ...(SUB ? ["logout"] : [])];
const WEB    = /^https?:\/\//;
const ODD    = AUTH ? undefined : ARGS.find((a) => !WORDS.includes(a) && !WEB.test(a) && a !== PORT);
const INSTALL = "https://raw.githubusercontent.com/lovexbytes/kazuki/main/install.sh";
const REMOTE = ARGS.find((a) => WEB.test(a));
const SERVER = (REMOTE ?? process.env.KAZUKI_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "").replace(/^http:\/\/(?:localhost|\[::1\])(?=[:/]|$)/, "http://127.0.0.1");

const USAGE = `Usage: kazuki [url]           the chat (url: $KAZUKI_URL, else http://127.0.0.1:8788)
       kazuki server          start its local server in the background
       kazuki tui             open the local server in this terminal
       kazuki web             start the local server and open it in a browser
       kazuki update [url]    install the latest kazuki (curl | sh, shown first)
       kazuki version         this kazuki's version
       kazuki serve [port]    your own Kazuki server, at http://127.0.0.1:8788
                            (another port: set KAZUKI_SITE to its address too),
                            on the providers connected (kazuki auth);
                            chat with it: kazuki http://127.0.0.1:8788
       kazuki auth            the providers, and which are connected
       kazuki auth <id>       how to connect one
       kazuki auth openai login   sign in with a ChatGPT plan, by a code
                            entered in any browser (logout: sign out)
       kazuki auth <id> use key|oauth  which method the provider runs on
       kazuki chatgpt [logout]  kazuki auth openai login [logout]
       kazuki help            this
KAZUKI_WORK: where the agent works on this computer (default
~/.kazuki/work). KAZUKI_COMPUTER=1: it may use the screen.
In the chat, /help lists every command and key.`;

// this device's name, as the agent sees it: on macOS its local host name
// (Bonjour's, unique on its network), else the host's
const LOCAL  = process.platform === "darwin" ? child.spawnSync("scutil", ["--get", "LocalHostName"]).stdout?.toString().trim() : "";
const DEVICE = LOCAL || os.hostname();

// where the agent's tools work on this device: in WORK/main (the agent)
// and WORK/<name> (each subagent)
const WORK = process.env.KAZUKI_WORK || "~/.kazuki/work";

// whether the agent may use this device's screen, mouse and keyboard
const COMPUTER = process.env.KAZUKI_COMPUTER === "1";

// Helpers
// =======

// runs the installer again: the one way kazuki changes. The command prints
// first, so one can run it alone.
function update_run(url: string): void {
  const script = url === "" ? INSTALL : url.replace(/\/$/, "") + "/install.sh";
  console.error("curl -fsSL " + script + " | sh");
  const got = child.spawnSync("curl", ["-fsSL", script], { stdio: ["ignore", "pipe", "inherit"] });
  if (got.status !== 0) {
    process.exitCode = got.status ?? 1;
    return;
  }
  process.exitCode = child.spawnSync("sh", [], { input: got.stdout, stdio: ["pipe", "inherit", "inherit"] }).status ?? 1;
}

// the terminal's chat on the server (tui/main.tsx, loaded only here: the
// server alone needs none of it)
async function tui_open(url: string): Promise<void> {
  const { tui_run } = await import("./tui/main.tsx");
  await tui_run({ url, device: DEVICE, work: WORK, screen: COMPUTER });
}

function cli_error(why: string): void {
  console.error("kazuki: " + why);
  process.exitCode = 1;
}

function local_url(url: string): number | null {
  try {
    const got = new URL(url);
    return got.protocol === "http:" && got.hostname === "127.0.0.1" ? Number(got.port || 80) : null;
  } catch {
    return null;
  }
}

// whether the local port is ours, occupied, or has no HTTP listener
async function local_live(url: string): Promise<"ours" | "occupied" | "absent"> {
  const res = await fetch(url + "/api/me", { signal: AbortSignal.timeout(750) }).catch(() => null);
  if (res === null) return "absent";
  const me = await res.json().catch(() => null);
  return res.ok && me?.id === "local" ? "ours" : "occupied";
}

// starts the server carried by this executable, then waits briefly for it.
async function local_start(url: string): Promise<boolean> {
  const port = local_url(url);
  if (port === null) {
    cli_error("local server must use http://127.0.0.1:<port>.");
    return false;
  }
  const live = await local_live(url);
  if (live === "ours") return true;
  if (live === "occupied") {
    cli_error(url + " is occupied by another HTTP service.");
    return false;
  }
  // a server with no provider connected, or picks it can't run, won't
  // start: said here, not in its log
  const { NONE, Plugin } = await import("./core/plugin.ts");
  if (!Plugin.ready()) {
    console.error(NONE);
    process.exitCode = 1;
    return false;
  }
  const { Providers } = await import("./ai/provider.ts");
  const config = await import("./config.ts");
  const picks = config.config_picks(Providers.offer(), Providers.catalog());
  if (!picks.ok) {
    cli_error(picks.error().message);
    return false;
  }
  const set = process.env.KAZUKI_DIR || os.homedir() + "/.kazuki";
  const dir = set.startsWith("~/") ? os.homedir() + set.slice(1) : set;
  const log = dir + "/server.log";
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = fs.openSync(log, "a", 0o600);
  let proc: child.ChildProcess;
  try {
    const source = process.argv[1] === import.meta.path && process.execPath === process.argv[0];
    const args = source ? [import.meta.path, "serve", String(port)] : ["serve", String(port)];
    proc = child.spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out], env: { ...process.env, KAZUKI_SITE: process.env.KAZUKI_SITE ?? url } });
  } catch (err: any) {
    fs.closeSync(out);
    cli_error("could not start local server at " + url + ": " + (err?.message ?? err) + " (log: " + log + ")");
    return false;
  }
  fs.closeSync(out);
  proc.unref();
  for (let k = 0; k < 40; k++) {
    if (await local_live(url) === "ours") {
      console.log("kazuki: local server started at " + url + " (pid " + proc.pid + ")");
      return true;
    }
    await Bun.sleep(100);
  }
  proc.kill("SIGTERM");
  cli_error("could not start local server at " + url + " (log: " + log + ")");
  return false;
}

// a TUI never starts a server: a failed local connection must not queue acts
async function local_tui(url: string): Promise<boolean> {
  if (local_url(url) !== null && await local_live(url) !== "ours") {
    cli_error("local server is not running at " + url + "; run kazuki server.");
    return false;
  }
  return true;
}

// Main
// ====

if (HELP || ODD !== undefined) {
  if (ODD !== undefined) {
    cli_error("no argument " + ODD + ".");
  }
  console.log(USAGE);
} else if (ASKVER) {
  console.log("kazuki " + VERSION);
} else if (UPDATE) {
  update_run(REMOTE ?? "");
} else if (AUTH) {
  const done = await (await import("./core/plugin.ts")).Plugin.auth(ARGS);
  if (!done.ok) {
    cli_error(done.error().message);
  }
} else if (SUB) {
  const done = await (await import("./ai/chatgpt.ts")).ChatGPT.cli(ARGS);
  if (!done.ok) {
    cli_error(done.error().message);
  }
} else if (SERVE) {
  await (await import("./core/server.ts")).serve(Number(PORT ?? 8788), null);
} else if (START) {
  await local_start(SERVER);
} else if (TUI) {
  if (await local_tui(SERVER)) {
    await tui_open(SERVER);
  }
} else if (SITE) {
  if (await local_start(SERVER)) {
    console.log(SERVER);
    browse(SERVER);
  }
} else {
  if (local_url(SERVER) === null) {
    await tui_open(SERVER);
  } else if (!await local_start(SERVER)) {
    // local_start has reported the error; do not open an offline terminal.
  } else {
    await tui_open(SERVER);
  }
}
