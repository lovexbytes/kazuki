// Commands
// ========
// Every act of the site as a command typed here (`/name arg`), by group:
// what /help lists and the input completes. Keys are App.tsx's (KEYS).

import * as fs from "node:fs";
import * as os from "node:os";
import * as Import from "../Import.ts";
import { Pick, type Move } from "../Pick.ts";
import { Price } from "../Price.ts";
import * as View from "../View.ts";
import { browse } from "../Browse.ts";
import { client_act, client_get, client_post, client_refusal, client_send, path_read, type Client } from "./Client.ts";

// Types
// =====

// a command: how it is typed, what it does, how it runs on its argument
export type Cmd = { use: string; text: string; run: (c: Client, arg: string) => void | Promise<void> };

// Constants
// =========

// where Claude Code and Codex keep their sessions
const CODEX   = process.env.CODEX_HOME ?? os.homedir() + "/.codex";
const IMPORTS = [
  (process.env.CLAUDE_CONFIG_DIR ?? os.homedir() + "/.claude") + "/projects",
  CODEX + "/sessions",
  CODEX + "/archived_sessions",
];

// what /import takes: its day; a site's export (its zip, or its
// conversations.json)
const SINCE  = /\bsince +(\d{4}-\d\d-\d\d)\b/;
const EXPORT = /\.(zip|json)$/i;
const HOW = "Pick with `/import [claude] [chatgpt] [since 2026-06-01] [tools] [sessions] [-#n] [<export>.zip] [go]` (-#n: not session n; go: import); `/import pause` or `resume`: the import running.\n\nExports, on each website: " + Object.entries(Import.EXPORTS).map(([app, how]) => "**" + app + "**: " + how).join("; ") + "; it emails you a zip.";

// the keys, as /help lists them
export const KEYS: [keys: string, text: string][] = [
  ["Enter",                   "send; on an empty input, interrupt Kazuki"],
  ["Shift+Enter, Ctrl+J",     "a new line"],
  ["Esc",                     "close what is open; else interrupt Kazuki's turn (agents go on)"],
  ["Ctrl+C",                  "clear the input; on an empty one, interrupt"],
  ["Ctrl+D",                  "clear the input; on an empty one, quit (the chat goes on without this terminal)"],
  ["Up, Down",                "the messages sent before, at the input's first or last line"],
  ["PageUp, PageDown",        "scroll the chat; Ctrl+End: back to its bottom"],
  ["Ctrl+O",                  "open or close every tool call's output"],
  ["Ctrl+F",                  "fold the chat into the fewest blocks; again: unfold"],
  ["Ctrl+P",                  "pick the model"],
  ["Shift+Left, Shift+Right", "the model before, the next"],
  ["Shift+Up, Shift+Down",    "more effort, less"],
  ["Shift+Tab",               "fast on, off"],
  ["Tab",                     "the next tab: an agent at work, then Kazuki again"],
  ["Ctrl+Z",                  "suspend; fg brings it back"],
  ["click",                   "a block opens (a summary, a tool call); its bar closes it"],
  ["drag",                    "select text; it is copied"],
];

// Commands
// ========

// all a person can type, by group; credit added only where the server
// bills
export function cmd_groups(c: Client): [group: string, cmds: Cmd[]][] {
  const topup: Cmd[] = c.v.bills ? [{ use: "/topup <usd>", text: "add Bend Credits, paid in the browser", run: cmd_topup }] : [];
  return [
    ["Chat", [
      { use: "/goal <message>", text: "send a message as the goal: at each turn's end, Kazuki asks itself if it is met, and goes on till it is", run: (c, a) => void client_act(c, { $: "Send", text: "/goal " + a }) },
      { use: "/halt",           text: "drop the goal; the turn running ends as it would", run: (c) => void client_act(c, { $: "Send", text: "/halt" }) },
      { use: "/image <path>",   text: "attach an image to the next message (or drop or paste its path)", run: cmd_image },
      { use: "/open #id",       text: "open block #id, as it shows, and keep it open", run: (c, a) => cmd_block(c, a, true) },
      { use: "/close #id",      text: "close block #id and keep it closed", run: (c, a) => cmd_block(c, a, false) },
      { use: "/fold",           text: "the chat in the fewest blocks; again: unfold", run: cmd_fold },
      { use: "/import [...]",   text: "import your Claude and ChatGPT chats (alone: options, costs)", run: cmd_import },
      { use: "/export",         text: "save memory and account as ./kazuki-memory.json", run: cmd_export },
      { use: "/tree",           text: "the whole memory, in the browser", run: (c) => cmd_browse(c, "The memory tree", c.url + "/tree") },
      { use: "/quit",           text: "leave: the chat goes on without this terminal", run: (c) => c.hooks.quit() },
      { use: "/help",           text: "every command and key", run: cmd_help },
    ]],
    ["Pick", [
      { use: "/model [name]",   text: "the models to pick from; with a name, that one", run: (c, a) => cmd_pick(c, "model", a) },
      { use: "/effort [level]", text: "the efforts; with one, that one", run: (c, a) => cmd_pick(c, "effort", a) },
      { use: "/speed [speed]",  text: "the speeds; with one, that one", run: (c, a) => cmd_pick(c, "speed", a) },
    ]],
    ["Agents", [
      { use: "/tab [name]",     text: "an agent's chat, or Kazuki's; alone: the tabs", run: cmd_tab },
      { use: "/stop [name]",    text: "stop all work, agents too; or that agent", run: cmd_stop },
    ]],
    ["Account", [
      ...topup,
      { use: "/account",        text: "balance, top-ups, charges, calls", run: cmd_account },
      { use: "/delete <name>",  text: "delete your account and chat (its name confirms)", run: cmd_delete },
    ]],
  ];
}

export function cmd_all(c: Client): Cmd[] {
  return cmd_groups(c).flatMap(([, cmds]) => cmds);
}

// the command's word: "/model" of "/model [name]"
export function cmd_word(cmd: Cmd): string {
  return cmd.use.split(" ")[0];
}

// a command typed (`/name arg`): runs it (pending while it works on);
// false if the text is none
export function cmd_run(c: Client, text: string): boolean {
  const word = text.trim().split(/\s+/)[0];
  const cmd  = cmd_all(c).find((k) => cmd_word(k) === word);
  if (cmd === undefined) {
    return false;
  }
  const run = cmd.run(c, text.trim().slice(word.length).trim());
  if (run instanceof Promise) {
    c.pending += 1;
    run.catch((err) => c.hooks.note(String(err?.message ?? err))).finally(() => {
      c.pending -= 1;
      c.bump();
    });
  }
  return true;
}

// the commands a word typed so far starts, for the input to complete
export function cmd_match(c: Client, typed: string): Cmd[] {
  if (!/^\/\S*$/.test(typed)) {
    return [];
  }
  return cmd_all(c).filter((k) => cmd_word(k).startsWith(typed.toLowerCase()));
}

// Help
// ----

function cmd_help(c: Client): void {
  const row  = (a: string, b: string) => "| `" + a + "` | " + b + " |";
  const cmds = cmd_groups(c).flatMap(([name, cmds]) => ["", "**" + name + "**", "", "| Command | |", "|---|---|", ...cmds.map((k) => row(k.use, k.text))]);
  const keys = ["", "**Keys**", "", "| Key | |", "|---|---|", ...KEYS.map(([k, t]) => row(k, t))];
  c.hooks.sheet("Help", [...cmds, ...keys].join("\n").trim());
}

// Chat
// ----

// attaches the image at a path to the next message, its bytes as read
// now (a Bun file inside a Blob adds nothing to it, Bun 1.3.14: the
// server got the text alone and refused the message); a file of another
// kind is refused here
export async function cmd_image(c: Client, arg: string): Promise<void> {
  const file = path_read(arg);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    c.hooks.note("No file " + arg + ".");
    return;
  }
  const bytes = await Bun.file(file).bytes();
  if (View.image_kind(bytes) === null) {
    c.hooks.note("Not attached: " + arg + " is no image. " + View.IMAGES);
    return;
  }
  c.setImgs([...c.imgs(), new Blob([bytes])]);
  c.hooks.note("Attached " + file.split("/").pop() + "; it goes with the next message.");
}

// the person's choice for block #id or #id+n (its name, View.block_name),
// open or closed, whatever it shows now: it holds until Fold all
function cmd_block(c: Client, arg: string, open: boolean): void {
  const name = /^#?(\d+)(?:\+(\d+))?$/.exec(arg);
  const id   = Number(name?.[1]);
  const n    = Number(name?.[2] ?? 1);
  if (name === null || block_row(View.view_body(c.v), id, n) === undefined) {
    c.hooks.note(arg === "" ? "Which block? " + (open ? "/open" : "/close") + " #id, as each block shows it." : "No block " + arg + " here.");
    return;
  }
  client_act(c, { $: open ? "Open" : "Shut", id, n });
}

// the row of block #id+n, among rows or inside their boxes
export function block_row(rows: View.Row[], id: number, n: number): View.Row | undefined {
  for (const r of rows) {
    if ((r.$ === "Sum" || r.$ === "Box") && r.id === id && r.n === n) {
      return r;
    }
    const inner = r.$ === "Box" ? block_row(r.rows, id, n) : undefined;
    if (inner !== undefined) {
      return inner;
    }
  }
  return undefined;
}

export function cmd_fold(c: Client): void {
  if (c.v.page === null) {
    client_act(c, { $: "Fold", on: c.v.fold === null });
  }
}

async function cmd_export(c: Client): Promise<void> {
  const res  = await client_get(c, "/export", "export");
  const file = process.cwd() + "/kazuki-memory.json";
  if (res !== null) {
    await Bun.write(file, res);
    c.hooks.note("Your data is in " + file + ".");
  }
}

function cmd_browse(c: Client, what: string, url: string): void {
  c.hooks.note(what + ": " + url);
  browse(url);
}

// this computer's Claude and ChatGPT chats, and the websites' exports
// given (EXPORT), not imported yet, as the words want (claude, chatgpt;
// Import.Want: since a day; tools; -#n: not session n): without go,
// what it finds and costs (sessions: and the list); with go, sent;
// pause, resume: the import running
async function cmd_import(c: Client, arg: string): Promise<void> {
  if (/^(pause|resume)$/.test(arg)) {
    return client_send(c, { $: "go", on: arg === "resume" });
  }
  const given = arg.replace(SINCE, "").split(/\s+/).filter((w) => w !== "");
  const files = given.filter((w) => EXPORT.test(w)).map((w) => w.replace(/^~(?=\/)/, os.homedir()));
  const words = given.filter((w) => !EXPORT.test(w)).map((w) => w.toLowerCase());
  const apps  = Import.APPS.filter((app) => words.includes(app.toLowerCase()));
  const want  = { off: [] as string[], since: arg.match(SINCE)?.[1] ?? "", tools: words.includes("tools") };
  if (words.some((w) => !/^(tools|sessions|go|-#\d+)$/.test(w) && !Import.APPS.some((app) => app.toLowerCase() === w))) {
    c.hooks.sheet("Import", "Not understood.\n\n" + HOW);
    return;
  }
  c.hooks.note("Looking for Claude and ChatGPT chats on this computer…");
  const read = await Promise.all([...IMPORTS.map(import_sessions), ...files.map(export_sessions)]).catch((e) => String(e.message ?? e));
  if (typeof read === "string") {
    c.hooks.note("Not imported: " + read);
    return;
  }
  const sessions = read.flat().filter((s) => apps.length === 0 || apps.includes(s.app));
  const done  = await client_get(c, "/api/imported", "read what Kazuki has");
  if (done === null) {
    return;
  }
  const old   = await done.json();
  const shown = Import.import_plan(sessions, want, old, View.view_count(c.v)).sessions;
  want.off    = shown.filter((_, k) => words.includes("-#" + (k + 1))).map(Import.import_id);
  const plan  = Import.import_plan(sessions, want, old, View.view_count(c.v));
  const found = "Found " + Import.import_count(plan.msgs, "new ") + ".";
  if (plan.msgs === 0) {
    c.hooks.sheet("Import", plan.first === "" ? Import.OLD : found + "\n\n" + HOW);
    return;
  }
  if (!words.includes("go")) {
    const which = words.includes("sessions") ? "\n\n" + shown.map((s, k) => "- #" + (k + 1) + " " + s.app + ": " + Import.import_line(s) + (want.off.includes(Import.import_id(s)) ? " (left out)" : "")).join("\n") : "";
    const out   = await new Promise<View.Answer>((ok) => View.link_send(c.v, { $: "guess", body: () => plan.sizes.join(",") }, ok));
    const cost  = out.usd === undefined ? "Not priced: " + client_refusal(out) : "Importing them costs about " + Import.guess_usd(out.usd) + ". To import them, type:\n\n```\n/import " + (arg + " go").trim() + "\n```";
    c.hooks.sheet("Import", found + which + "\n\n" + cost + "\n\n" + HOW);
    return;
  }
  c.hooks.note(found + " Sending them…");
  client_send(c, { $: "import", body: () => Import.import_body(plan.picked) });
}

// a dir's sessions (none if it is missing), a file at a time
async function import_sessions(dir: string): Promise<Import.Session[]> {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => dir + "/" + f).filter(Import.import_file) : [];
  const found: Import.Session[] = [];
  for (const f of files) {
    found.push(...[await Import.import_session(Bun.file(f), "log")].filter((s) => s !== null));
  }
  return found;
}

// a site's export file's sessions
async function export_sessions(path: string): Promise<Import.Session[]> {
  if (!fs.existsSync(path)) {
    throw new Error("no file " + path);
  }
  return Import.import_export(Bun.file(path));
}

// Pick
// ----

// a part of the pick: to the value given, or, none, the list to pick from
function cmd_pick(c: Client, move: "model" | "effort" | "speed", arg: string): void {
  if (arg === "" && c.v.pick !== null) {
    c.hooks.pick(move);
    return;
  }
  client_act(c, { $: "Move", move, to: arg });
}

// a pick's options for a list: each value, its pick, whether it is now's
export function pick_options(c: Client, move: Move): { text: string; hint: string; to: string; now: boolean }[] {
  const pick = c.v.pick;
  if (pick === null) {
    return [];
  }
  const knob = View.view_pick(c.v).find((k) => k.move === move);
  const seen = new Set<string>();
  return Pick.options(pick, move, c.v).flatMap(([part, p]) => {
    const twin = move === "model" && Pick.twin(p.vendor, part, c.v.vendors);
    const to   = twin ? p.vendor + ":" + part : part;
    if (seen.has(to)) {
      return [];
    }
    seen.add(to);
    const now  = part === knob?.text && p.vendor === pick.vendor;
    const rate = move === "model" ? Price.rate(Pick.ask(p).model) : undefined;
    const cost = rate === undefined ? "" : "$" + rate.input + "/M in, $" + rate.output + "/M out";
    return [{ text: part, hint: [twin ? p.vendor : "", cost].filter((x) => x !== "").join(" · "), to, now }];
  });
}

// Agents
// ------

// shows an agent's chat, by the start of its name, or Kazuki's; no
// name lists the tabs
function cmd_tab(c: Client, arg: string): void {
  const main = arg.toLowerCase() === View.MAIN.toLowerCase();
  if (arg === "") {
    c.hooks.note("Tabs: " + View.view_tabs(c.v).map((tab) => tab.name ?? View.MAIN).join(", "));
    return;
  }
  client_act(c, { $: "Goto", name: main ? null : agent_named(c, arg) });
}

// the next tab
export function cmd_cycle(c: Client): void {
  const tabs = View.view_tabs(c.v);
  const at   = tabs.findIndex((tab) => tab.here) + 1;
  client_act(c, { $: "Goto", name: tabs[at % tabs.length].name });
}

// stops all that runs, or the agent named
function cmd_stop(c: Client, arg: string): void {
  const name = agent_named(c, arg);
  if (arg !== "" && !c.v.agents.includes(name)) {
    c.hooks.note("No agent " + arg + " at work.");
    return;
  }
  client_send(c, arg === "" ? { $: "stop" } : { $: "stop", name });
}

// an agent at work whose name starts with arg, else arg
function agent_named(c: Client, arg: string): string {
  return c.v.agents.find((a) => a.toLowerCase().startsWith(arg.toLowerCase())) ?? arg;
}

// Account
// -------

async function cmd_topup(c: Client, arg: string): Promise<void> {
  const out = await client_post(c, "/api/topup", { usd: Number(arg) });
  if (typeof out.url !== "string") {
    c.hooks.note(out.error ?? "Could not top up: no connection.");
    return;
  }
  cmd_browse(c, "The payment", out.url);
}

async function cmd_account(c: Client): Promise<void> {
  const res = await client_get(c, "/api/account", "read the account");
  const a   = res === null ? null : await res.json() as View.Account;
  if (a !== null) {
    c.hooks.sheet("Account", View.account_md(a));
  }
}

// deletes the account, once its name is typed; the server says what
// deleting does, and the name, when it isn't
async function cmd_delete(c: Client, arg: string): Promise<void> {
  const out = await client_post(c, "/api/delete", { confirm: arg });
  if (!out.ok) {
    c.hooks.note(out.error ?? "No connection.");
    return;
  }
  c.hooks.note("Your account and chat are deleted.");
  c.hooks.quit();
}
