// AskAI
// =====
// One way to call a model: a system prompt and a user message in;
// Deltas (live pieces) and an Entry per finished message out. send()
// hands the agent a message at its next chance, stop() aborts, `left`
// holds those never taken. Every vendor is an API run in our loop
// (agent.ts). A patient call (a summary's) asks again, AGAIN after each
// try nothing answered (the vendor down or refusing it, as when the API
// key's credit is gone; our setup failing) or, if the vendor said when
// its refusal lifts (`until`: a ChatGPT plan's usage limit), then (a week
// at most), till
// one is answered or we end it (a stop): an outage only delays it, and
// no summary is made of a failure that isn't its input's (memory.ts). A
// call that yields (an import's summary, naming its import) sends nothing
// while one that doesn't waits on its busy model, nor while another of
// its import's does (agent.ts). A call's events and end go to its sink,
// which moves with its chat to another process (server.ts): the call
// runs on where it started.
//
// Cache: a marked block ends a prefix the vendor caches. Single flight
// (AskAI.wait), as a request is sent: one whose prefix no call cached
// within TTL leads; one whose prefix a leader is writing waits until the
// leader's response begins (only then can it read the entry). So a leader
// is always a request being sent, never one yielding (agent.ts), which
// every user's calls of its prefix would wait on.

import { Agent } from "./agent.ts";
import { stream_lines } from "../util/clip.ts";
import { Machine } from "../device/machine.ts";
import type { Pick } from "./pick.ts";
import { Providers } from "./provider.ts";

// Types
// =====

// the user's, an agent's report ("[Name]\n...", a user turn to the
// model), a thought (shown, never logged), a reply, a tool call, its
// result, a note from before the chat (imported)
export type Kind = "user" | "work" | "mind" | "unii" | "tool" | "echo" | "note";

// a provider's id (provider.ts)
export type Vendor = string;

// an image: its mime type, its bytes in base64
export type Img = { type: string; data: string };

// a message for the agent
export type Say = { text: string; imgs: Img[] };

// a text block of a call's message; `mark`: a cache entry ends after it
export type Block = { text: string; mark: boolean };

// what a summary serves: the chat, or an import
export type Served = "compactor" | "import";

// searches: the most web searches it runs (0: no web tools)
export type Ask = Pick & {
  system    : string;
  blocks    : Block[];
  imgs?     : Img[];
  searches  : number;
  server    : string;
  patient?  : boolean;
  yields?   : string;
};

// a prefix cached: until when; while its leader's response has not
// begun, what its waiters wait on
type Cached = { until: number; ready: Promise<void> | null };

// a request's place in single flight: its response began; it ended
export type Flight = { begun: () => void; end: () => void };

export type Event =
  | { $: "Delta"; kind: Kind; text: string; fresh?: boolean }
  | { $: "Entry"; kind: Kind; text: string; of?: string }; // of: the tool call it is or answers (a call is logged with its result)

// stop: who ended a call that failed (agent.ts): the model (`fail`: it
// answered, so the failure is its input's doing, a refusal or a stop
// reason; asked again, it fails alike), we (`lost`: a stop), the vendor
// (`down`), or none (our setup threw);
// until: when the vendor's refusal lifts, if it said (ms since 1970)
export type End = {
  ok     : boolean;
  text   : string;
  left   : Say[];
  note?  : string;
  stop?  : "fail" | "lost" | "down";
  until? : number;
};

// one try at a vendor
export type Try = {
  send : (say: Say) => void;
  stop : () => void;
  done : Promise<End>;
};

// where a call's events and end go
export type Sink = { on: (ev: Event) => void; end: (end: End) => void };

// a call: its done is its first sink's end; `move` sends what comes
// after to another (its chat moved to another process: server.ts)
export type Call = Try & { move: (to: Sink) => void };

// Constants
// =========

// how long a patient call waits to ask again: short enough that summaries
// go on within a minute of an outage's end, long enough not to flood the
// vendor meanwhile (its JOBS a side per chat each asking once a minute)
const AGAIN = 60e3;

// the longest a patient call waits for a refusal to lift (a ChatGPT
// plan's limits last a week at most)
const WEEK = 7 * 86400e3;


// the prefixes cached, by key (AskAI.keys)
const CACHE = new Map<string, Cached>();

// AskAI
// =====

export namespace AskAI {

  // a call: its tries, one after another (a patient one's)
  export function ask(ask: Ask, on: (ev: Event) => void): Call {
    const halt = new AbortController();
    const send = (say: Say) => call.send(say);
    const stop = () => {
      halt.abort();
      call.stop();
    };
    const [out, feed] = AskAI.tie(on, send, stop);
    let call = AskAI.start(ask, feed.on);
    const run = async (): Promise<End> => {
      let end = await call.done;
      for (;;) {
        const wait = ask.patient === true && !end.ok && end.stop !== "fail" && end.stop !== "lost";
        if (wait) {
          await Machine.nap(Math.min(WEEK, Math.max(AGAIN, (end.until ?? 0) - Date.now())), halt.signal);
        }
        if (halt.signal.aborted || !wait) {
          return end;
        }
        call = AskAI.start(ask, feed.on);
        end.left.forEach(send);
        end = await call.done;
      }
    };
    run().then(feed.end, (err) => feed.end(AskAI.end(String(err?.message ?? err))));
    return out;
  }

  // a call fed by `feed` (its tries, or another process: server.ts),
  // which passes all to the call's sink: first `on` and done
  export function tie(on: Sink["on"], send: Try["send"], stop: Try["stop"]): [Call, Sink] {
    const { promise, resolve } = Promise.withResolvers<End>();
    let to: Sink = { on, end: resolve };
    const feed: Sink = { on: (ev) => to.on(ev), end: (end) => to.end(end) };
    return [{ send, stop, done: promise, move: (sink) => (to = sink) }, feed];
  }

  // one try; a vendor that throws gives a failed one
  export function start(ask: Ask, on: (ev: Event) => void): Try {
    try {
      return Agent.ask(ask, on);
    } catch (err: any) {
      const end = AskAI.end(err.message);
      const send = (say: Say) => end.left.push(say);
      return { send, stop: () => {}, done: Promise.resolve(end) };
    }
  }

  // a call's end, before it ends: failed, saying `text`
  export function end(text: string): End {
    return { ok: false, text, left: [] };
  }

  // Cache
  // -----

  // the keys of a call's prefix at each block end through its last mark
  // before its end: what it runs on, its system prompt, tools and blocks,
  // each block's hash seeded by the one before (64 bits)
  export function keys(ask: Ask): string[] {
    const last = ask.blocks.slice(0, -1).findLastIndex((b) => b.mark);
    const head = [ask.vendor, ask.model, ask.effort, ask.speed, ask.system, ask.searches > 0];
    let key = Bun.hash(JSON.stringify(head));
    return ask.blocks.slice(0, last + 1).map((b) => String((key = Bun.hash(b.text, key))));
  }

  // single flight: waits while a leader writes the longest cached part of
  // the call's prefix; then leads, unless its whole prefix is cached
  export async function wait(ask: Ask): Promise<Flight> {
    const keys = AskAI.keys(ask);
    const ttl = Providers.route(Providers.get(ask.vendor)).ttl;
    for (;;) {
      const now = Date.now();
      const live = (key: string) => CACHE.get(key)?.ready || (CACHE.get(key)?.until ?? 0) > now;
      const k = keys.findLastIndex(live);
      const got = k < 0 ? null : CACHE.get(keys[k])!;
      if (got?.ready) {
        await got.ready;
        continue;
      }
      if (got !== null) {
        got.until = now + ttl;
        CACHE.delete(keys[k]);
        CACHE.set(keys[k], got);
      }
      if (k === keys.length - 1) {
        return { begun: () => {}, end: () => {} };
      }
      return AskAI.lead(keys[keys.length - 1], ttl, now);
    }
  }

  // the call writing `key`; old entries go as a new one comes, the least
  // lately used first, up to the first still live (a process's calls of
  // all its chats share CACHE)
  export function lead(key: string, ttl: number, now: number): Flight {
    for (const [k, c] of CACHE) {
      if (c.ready !== null || c.until >= now) {
        break;
      }
      CACHE.delete(k);
    }
    let free = () => {};
    const own: Cached = { until: 0, ready: new Promise((ok) => (free = ok)) };
    CACHE.set(key, own);
    const begun = () => {
      if (own.ready !== null) {
        own.ready = null;
        own.until = Date.now() + ttl;
        free();
      }
    };
    const end = () => {
      if (own.ready !== null) {
        CACHE.delete(key);
        own.ready = null;
        free();
      }
    };
    return { begun, end };
  }

  // the non-empty lines of a byte stream
  export async function* lines(stream: ReadableStream<Uint8Array>) {
    for await (const lines of stream_lines(stream)) {
      yield* lines.map((line) => line.trim()).filter((line) => line !== "");
    }
  }

  // a tool result's content (a string, or MCP parts) as text
  export function show(content: any): string {
    if (typeof content === "string") {
      return content;
    }
    return (content ?? []).map((part: any) => part.text ?? "[" + part.type + "]").join("\n");
  }

}
