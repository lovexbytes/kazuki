// Shared
// ======
// The types and constants the server files share.

import * as fs from "node:fs";
import type { ServerWebSocket } from "bun";
import { type Call, type Sink } from "../../ai/ask-ai.ts";
import { type User } from "../cloud.ts";
import { type Given } from "../memory.ts";
import { type Live, type Moved as Kit } from "../tools.ts";
import { type Part } from "../../view/view.ts";
import * as config from "../config.ts";
import hello_md from "../hello.md" with { type: "text" };
import app_js from "../../../web/app.js" with { type: "file" };
import index_page from "../../../web/index.html" with { type: "file" };
import install_sh from "../../../install.sh" with { type: "file" };
import mark_svg from "../../../web/mark.svg" with { type: "file" };
import experimental_jpg from "../../../web/experimental.jpg" with { type: "file" };
import og_png from "../../../web/og.png" with { type: "file" };
import style_css from "../../../web/style.css" with { type: "file" };

// Types
// =====

// a socket: its user, sign-in (hashed), its query's fields, its device,
// the parts it was shown (Views.teach)
export type Sock = ServerWebSocket<{ user: User; who: string; tab: string; wire: string | null; host: string | null; computer: boolean; work: string; device: string | null; seen: Set<string> }>;

// a body: its file, its size so far
export type Body = { fh: fs.promises.FileHandle; size: number };

// a message logged: its pages [id, end)
export type Msg = { id: number; end: number };

// what the agent saw at its last call: the view before message `from`,
// then every message from it on
export type Eye = { parts: Part[]; from: number };

// a goal check (Chat.check): its call (here, or by its ref as its chat
// moves), the goal it asks of
export type Check<C> = { call: C; goal: string };

// an import as kept: messages [a, b), those sent (not notes); as run: by
// level what each node costs (micro-USD, Import.import_guess) and how many
// are not built; their cost; its time (Ingest.time) in all
export type Kept  = { a: number; b: number; said: number };
export type Batch = Kept & { micros: number[][]; open: number[]; left: number; all: number };

export type Moved = { user: string; turn: Turn; tools: Kit; sums: Given[] };
export type Turn = { busy: boolean; call: string | null; model: string; check: Check<string> | null; sent: Msg[]; wait: Msg[]; asked: boolean; open: number; live: Live[]; calls: Record<string, string>; eye: Eye };

// another process (the one this gives its chats to or takes them from,
// or one a call is fed from or to), by a line of JSON a message
// (Main.told): the calls fed from it here, by ref (Main.far); end: the
// line closed once all sent is out, then `then`
export type Peer = {
  send   : (msg: object) => void;
  end    : (then: () => void) => void;
  feeds  : Map<string, Sink>;
};

// a call fed from here to the process its chat is in (Main.away): run
// here, or passed on (a relay) till its origin feeds that process itself
export type Away = { call: Call; link: Peer };

// a call fed here by its origin while its relay (the process its chat
// came from) still passes on what reached it first: what came straight
// meanwhile, held; whether its origin's line was lost
export type Gate = { relay: Peer; origin: Peer; held: any[]; lost: boolean };

// a rate limit (Main.spend): what each key (a user, a network) may still
// spend, as of when; it grows `rate` a second, up to `most`
export type Limit = { rate: number; most: number; keys: Map<string, { n: number; at: number }> };

// Constants
// =========

export const LOCK       = config.DIR + "/lock";
// what the config set and lost, as last told (Chat.lost)
export const LOST: { told: string[] } = { told: [] };
// how long the supervisor waits to start again a worker whose start failed
export const RETRY      = 5e3;
// where worker k's successor reaches it, HAND + k (Main.listen); how
// often one that gave its chats looks whether its last requests ended
export const HAND       = config.DIR + "/hand";
export const LEAVE      = 500;
// how a call ends whose process ended first (a crash)
export const ENDED      = "the server process that ran it ended";
// a turn's head, as a summary's is "Compaction:": one prompt serves both
export const HEAD       = "Turn: the user's new message:\n\n";
// a goal's check (Chat.check): its own system prompt (Kazuki's, which says
// a call is a turn or a compaction, made the model summarize the chat
// instead of answering), asked after the chat (the view, its latest
// messages whole) of its goal; unmet, the user's nudge
export const GOAL       = "You check a goal. Below is a chat between a user and Kazuki, an AI agent: its older messages as summary lines (id+n|text), then its latest messages whole, then the goal the user set with /goal. Answer yes if the chat shows the goal fully satisfied now, else no. Write that one word, nothing else.";
export const GOAL_ASK   = "\nThe goal:\n\n";
export const GOAL_NO    = "The goal isn't satisfied yet: keep working.";
export const FULL       = "Kazuki's disk is full; try again soon.";
// an import running: its batch's file in the chat's dir (Ingest.keep)
export const BATCH      = "/import.json";
// under SPARE free, the disk takes no more (Views.post)
export const SPARE      = 2 ** 30;

// the acts with a body (Views.post)
export const BODIES     = ["say", "import", "voice"];

// a read of a body: a buffer, no limit
export const READ       = 2 ** 20;

// what a socket may hold unsent (Bun's default, 16 MiB, drops the rest)
export const BUFFER     = 2 ** 31 - 1;

// a piece of a long answer (Main.stream)
export const PIECE      = 2 ** 16;

// what a user's clients may send (Main.spend): 200 messages (acts, asks,
// sockets opened) at once, 100 more a second, each counting once more
// for each UNIT in it (none is over View.FRAME); past it, a socket is
// closed (FLOOD) unread, a socket or an act posted refused (429), so no
// user's flood holds the worker every chat on it shares (a client opens
// again and sends what wasn't answered; a person's clicks, keys and
// tools never come near: a screenshot counts ~3)
export const USERS: Limit = { rate: 100, most: 200, keys: new Map() };
export const UNIT       = 2 ** 16;
export const FLOOD      = 1008;

// the sockets a user's clients may hold open at once (Main.sockets: a
// view each, a tab, a terminal, the app); past it a new one is refused
// (429), so no user fills the worker's memory with sockets, each of which
// may hold an unfinished message up to View.FRAME
export const SOCKETS    = 32;

// what a network (Cloud.net: an IPv4 address, an IPv6 /48) may ask of the
// local server: 1,000 requests at once, 100 more a second; past it the
// supervisor answers 429, so no worker hears it.
export const NETS: Limit = { rate: 100, most: 1000, keys: new Map() };

// the model requests a worker may have open at once (Bun's fetch: 256)
export const FETCHES    = 65535;

// the local chat's paths, besides /api/ (the rest: the site's files)
export const OWN        = ["/ws", "/tree", "/export"];

export function local_request(req: Request): boolean {
  const url = new URL(req.url);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const origin = req.headers.get("origin");
  return ["127.0.0.1", "localhost", "::1"].includes(host) && (origin === null || origin === url.origin);
}


// the first message, ending in the installer every terminal starts from
export const HELLO      = hello_md.trim().replace("{install}", config.SITE + "/install.sh");

// with type "file", the page's path: Bun's types say an HTMLBundle
export const index_html = index_page as unknown as string;

// the site's files, by path (a new one is imported above)
export const WEB: Record<string, string> = {
  "/"               : index_html,
  "/account"        : index_html,
  "/app.js"         : app_js,
  "/experimental.jpg": experimental_jpg,
  "/favicon.svg"    : mark_svg,
  "/install.sh"     : install_sh,
  "/mark.svg"       : mark_svg,
  "/og.png"         : og_png,
  "/style.css"      : style_css,
};

// a new account's chat opens as its guest's talk went (main.ts guest), so
// its next line follows from the email: hello.md asking for it (View.ask),
// the email, and SIGNED. The hello's node is written with it, so no
// compactor call summarizes the three (with an email of up to 254 bytes,
// a node of at most 512 bytes) and a new account owes nothing.
export const HELLO_LINE = "kazuki: hello: Kazuki, one persistent local chat with a memory tree.";

export const OPEN_PROMPT = "What should we start with?";
