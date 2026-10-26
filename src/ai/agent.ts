// Agent
// =====
// Every provider (provider.ts) in Kazuki's own loop; its Wire
// (anthropic.ts, openai.ts, chatgpt.ts, a plugin's) shapes requests and
// reads streams. Each step sends every item and streams one output;
// tool calls run in order, a message sent mid-run follows the next
// results, and the call ends at a step with no tools and nothing sent.
// A request goes again, TRIES times at most, after its retry-after or a
// doubling wait, for a passing reason (`busy`: no connection, a retry
// status, a stream error, cut short or silent for the wire's `idle`),
// dropping what it streamed. A request that yields (an import's
// summary, ask-ai.ts) sends nothing while one that doesn't (a turn's, a
// chat's summary, which a turn waits on) waits on its busy model: the
// room a busy vendor has goes to the chats first, and many imports
// never starve every chat of the summaries its next turn needs. An
// import asks a busy model again by one request at a time, the rest
// waiting on it, so imports share what room is left alike, however many
// requests each runs. A busy model is logged as its first request asks
// again and as its last is done, never each try (a storm logged ~600
// lines a second). A call ends answered (`fail`: the model's answer
// failed, a refusal or a stop reason: its input's doing) or not:
// `down`, the vendor's (a refusal of the request, as when the API key's
// credit is gone, or busy past TRIES); `lost`, ours (a stop), saying
// why. A vendor's why (`busy`, `down`) goes to the log, and a call that
// ends `down` says it too (the server's account is the user's: Kazuki
// is local); each retry's thought and where a call is cut say only that
// the AI service is busy. A stop ends the call at once. A
// request takes its place in single flight (AskAI.wait).

import { live_push } from "./live.ts";
import { AskAI, type Ask, type Block, type Flight, type Try, type End, type Event, type Img, type Kind, type Say } from "./ask-ai.ts";
import { Providers, type Provider } from "./provider.ts";
import { nap } from "../util/nap.ts";
import * as config from "../config.ts";
import { caught, Err, Ok, type Result } from "../util/result.ts";

// Types
// =====

export type Out = { text: string; fail: boolean; imgs?: Img[] };

// a tool as the vendors see it: its name, what it does, its input's
// JSON Schema
export type Spec = { name: string; info: string; schema: object };

export type Tool = Spec;

// a running call: the messages sent mid-run not taken yet
type Run = {
  ask   : Ask;
  on    : (ev: Event) => void;
  sent  : Say[];
  abort : AbortController;
  end   : End;
};

export type Back = { id: string; out: Out };

// a room at a busy model, a model's or an import's (ask-ai.ts `yields`):
// the requests asking again that hold it (a model's: those that don't
// yield; an import's: the one asking for all its requests), and those
// waiting till none does; a model's counts all its requests asking
// again too, logged as they go from none to some and back
type Room = { busy: number; asking: number; wait: Array<() => void> };

export type Item =
  | { $: "User"; parts: Block[]; imgs: Img[] } // user text, images
  | { $: "Turn"; out: unknown[] }             // the model's output, as its API gave it
  | { $: "Back"; backs: Back[] };             // tool results

// a tool call: its input (null: not JSON)
export type Use = { id: string; name: string; input: unknown };

export type Entry = { kind: Kind; text: string; of?: string };

// note: what it did other than asked; refusal: the vendor's, if down by
// one
export type Step = {
  out      : unknown[];
  uses     : Use[];
  entries  : Entry[];
  stop     : "done" | "tools" | "again" | "busy" | "down" | "lost" | "fail";
  why      : string;
  note     : string;
  refusal? : Refusal;
};

// a refusal asking again soon won't change (a ChatGPT plan's usage
// limit): why (logged), what the user reads, and when it lifts, if told
// (ms since 1970)
export type Refusal = { why: string; say: string; until?: number };

export type Emit = (kind: Kind, text: string, fresh?: boolean) => void;

// an API: `auth`, a signed-in account's token for each try (refused: the
// one a 401 refused, which it refreshes; an error with `busy` set: none
// for now), else its provider's key (provider.ts); how its stream reads
// into a step (S: what it read so far), and which error responses are
// refusals (null: not one)
export type Wire<S> = {
  auth?   : (refused: string | undefined) => Promise<Result<string, Error>>;
  refusal?: (res: Response, body: string) => Refusal | null;
  idle    : number;
  url     : string;
  headers : (key: string, ask: Ask) => Record<string, string>;
  body    : (ask: Ask, items: Item[], tools: Tool[], max: number) => unknown;
  start   : (ask: Ask) => S;
  read    : (st: S, ev: any, on: Emit) => boolean;
  begun   : (ev: any) => boolean;
  step    : (st: S, ask: Ask) => Step;
};

// Constants
// =========

// a request's most output tokens: the models' own cap
const MAX   = 128000;
export const TRIES = 8;

// what a call the vendor never answered says
const BUSY  = "the AI service is busy or unavailable right now";

// the rooms held or waited on, by model, or model and import (Agent.step)
const ROOMS = new Map<string, Room>();

// the requests sent whose answers are not read to their end: a process
// ends only once none is (main.ts Main.leave), and a sign-in's token
// being got (Agent.token)
export const READING = { n: 0 };

// Agent
// =====

export namespace Agent {

  export function ask(ask: Ask, on: (ev: Event) => void): Try {
    const end = AskAI.end("");
    const run: Run = { ask, on, sent: [], abort: new AbortController(), end };
    const send = (say: Say) => run.sent.push(say);
    const stop = () => {
      end.text = "stopped";
      run.abort.abort();
    };
    const done = (async () => {
      // a bug that throws ends the call alike, saying it
      try {
        const done = await Agent.loop(Providers.get(ask.vendor), run);
        if (!done.ok) {
          end.text ||= done.error().message;
        }
      } catch (err: any) {
        end.text ||= err.message;
      }
      end.ok   = end.ok && !run.abort.signal.aborted;
      end.left = run.sent;
      return end;
    })();
    return { send, stop, done };
  }

  export async function loop(p: Provider, run: Run): Promise<Result<void, Error>> {
    const { ask, on, end } = run;
    const { wire, used } = Providers.route(p);
    const signal = run.abort.signal;
    if (used === undefined) {
      return new Err(new Error(p.name + " isn't connected: run `kazuki auth " + p.id + "`"));
    }
    const key = used.type === "key" ? config.secret(used.envs[0]) : "";
    const listed = await Agent.server(run);
    if (!listed.ok) {
      return new Err(listed.error());
    }
    const tools = listed.value();
    const parts = ask.blocks.filter((b) => b.text !== "");
    const items: Item[] = [{ $: "User", parts, imgs: ask.imgs ?? [] }];
    while (!signal.aborted) {
      const got = await Agent.step(wire, run, key, wire.body(ask, items, tools, MAX));
      if (!got.ok) {
        return new Err(got.error());
      }
      const step = got.value();
      for (const entry of step.entries) {
        on({ $: "Entry", ...entry });
      }
      if (step.stop === "down" || step.stop === "lost" || step.stop === "fail") {
        end.text ||= step.stop === "down" ? step.refusal?.say ?? step.why : step.why;
        end.stop = step.stop;
        end.until = step.refusal?.until;
        return new Ok();
      }
      items.push({ $: "Turn", out: step.out });
      end.note = step.note || end.note;
      if (step.stop === "again") {
        continue;
      }
      const backs: Back[] = [];
      for (const use of step.uses) {
        if (signal.aborted) {
          return new Ok();
        }
        const out = await Agent.use(run, tools, use);
        on({ $: "Entry", kind: "echo", text: (out.fail ? "error: " : "") + out.text, of: use.id });
        backs.push({ id: use.id, out });
      }
      if (signal.aborted) {
        return new Ok();
      }
      const says = run.sent.splice(0);
      const replies = step.entries.filter((e) => e.kind === "unii");
      const text = replies.map((e) => e.text).join("\n\n");
      if (backs.length === 0 && says.length === 0) {
        end.ok   = true;
        end.text = text;
        return new Ok();
      }
      for (const say of says) {
        on({ $: "Entry", kind: "user", text: say.text });
      }
      if (backs.length > 0) {
        items.push({ $: "Back", backs });
      }
      if (says.length > 0) {
        const parts = says.filter((say) => say.text !== "").map((say) => ({ text: say.text, mark: false }));
        const imgs = says.flatMap((say) => say.imgs);
        items.push({ $: "User", parts, imgs });
      }
    }
    return new Ok();
  }

  // body: the request's. Asking again, it holds its room (Room): its
  // model's, or its import's, which one request holds at a time while the
  // rest wait on it, so each import has one request at a busy model
  // however many it runs, and imports share its room alike
  export async function step<S>(wire: Wire<S>, run: Run, key: string, body: unknown): Promise<Result<Step, Error>> {
    const signal = run.abort.signal;
    const model = run.ask.model;
    const own = run.ask.yields === undefined ? model : model + " " + run.ask.yields;
    let asking = false;
    let refused: string | undefined;
    try {
      for (let k = 1; !signal.aborted; k++) {
        await Agent.yielded(run, own, asking);
        if (signal.aborted) {
          return new Ok(Agent.fail("stopped", []));
        }
        const seen: Entry[] = [];
        const stopped = new Promise<null>((done) => signal.addEventListener("abort", () => done(null), { once: true }));
        const token = await Promise.race([Agent.token(wire, key, refused), stopped]);
        if (token === null) {
          return new Ok(Agent.fail("stopped", seen));
        }
        if (!token.ok) {
          return new Err(token.error());
        }
        const sent = typeof token.value() === "string" ? Agent.request(wire, run, token.value() as string, body, seen) : Promise.resolve({ res: null, step: token.value() as Step });
        const got = await Promise.race([sent, stopped]);
        if (got === null) {
          return new Ok(Agent.fail("stopped", seen));
        }
        const { res, step } = got;
        if (res?.status === 401 && wire.auth && refused === undefined) {
          refused = token.value() as string;
          k -= 1;
          continue;
        }
        if (step.stop === "down") {
          console.error(model + ": " + step.why.slice(0, 300));
        }
        if (step.stop !== "busy" || k >= TRIES) {
          return new Ok(step.stop === "busy" ? { ...step, stop: "down" } : step);
        }
        if (!asking && own !== model && (ROOMS.get(own)?.busy ?? 0) > 0) {
          continue;
        }
        if (!asking) {
          Agent.hold(model, own, step.why);
          asking = true;
        }
        const after = Number(res?.headers.get("retry-after") ?? "");
        const wait = after > 0 ? after : 2 ** k;
        run.on({ $: "Entry", kind: "mind", text: "The AI service is busy: asking again in " + wait + " s." });
        await nap(wait * 1000, signal);
      }
      return new Ok(Agent.fail("stopped", []));
    } finally {
      if (asking) {
        Agent.free(model, own);
      }
    }
  }

  // a try's key, or a signed-in wire's token (refused: the one a 401
  // refused); one it can't get for now, a busy step. Getting it counts in
  // READING even once the call stopped: a refresh spends its refresh
  // token, so the process lives till the new ones are saved
  export async function token<S>(wire: Wire<S>, key: string, refused: string | undefined): Promise<Result<string | Step, Error>> {
    if (wire.auth === undefined) {
      return new Ok(key);
    }
    READING.n += 1;
    try {
      const got = await wire.auth(refused);
      const err = got.ok ? null : (got.error() as Error & { busy?: boolean });
      return err?.busy === true ? new Ok(Agent.fail(err.message, [], "busy")) : got;
    } finally {
      READING.n -= 1;
    }
  }

  export function room(key: string): Room {
    const room = ROOMS.get(key) ?? { busy: 0, asking: 0, wait: [] };
    ROOMS.set(key, room);
    return room;
  }

  // a request asks `model` again, holding `own`, its model's room or its
  // import's; the model's first says why
  export function hold(model: string, own: string, why: string): void {
    if (Agent.room(model).asking++ === 0) {
      console.error(model + ": " + why.slice(0, 300) + ": its requests ask again");
    }
    Agent.room(own).busy += 1;
  }

  // ... and lets go of it, answered or not: the last frees those waiting
  export function free(model: string, own: string): void {
    const room = Agent.room(own);
    room.busy -= 1;
    if (room.busy === 0) {
      room.wait.splice(0).forEach((ok) => ok());
    }
    if (--Agent.room(model).asking === 0) {
      console.error(model + ": none asks again");
    }
    for (const key of [own, model]) {
      if (ROOMS.get(key)?.busy === 0 && ROOMS.get(key)?.asking === 0) {
        ROOMS.delete(key);
      }
    }
  }

  // a request that yields waits while a request that doesn't holds its
  // model's room, and while another holds its import's
  export async function yielded(run: Run, own: string, asking: boolean): Promise<void> {
    const keys = run.ask.yields === undefined ? [] : asking ? [run.ask.model] : [run.ask.model, own];
    for (;;) {
      const room = keys.map((key) => ROOMS.get(key)).find((room) => (room?.busy ?? 0) > 0);
      if (room === undefined || run.abort.signal.aborted) {
        return;
      }
      await new Promise<void>((ok) => {
        room.wait.push(ok);
        run.abort.signal.addEventListener("abort", () => ok(), { once: true });
      });
    }
  }

  // one request, sent once it has its place in single flight
  // (AskAI.wait): its response, if any, and step
  export async function request<S>(wire: Wire<S>, run: Run, key: string, body: unknown, seen: Entry[]): Promise<{ res: Response | null; step: Step }> {
    const flight = await AskAI.wait(run.ask);
    if (run.abort.signal.aborted) {
      flight.end();
      return { res: null, step: Agent.fail("stopped", []) };
    }
    READING.n += 1;
    return Agent.send(wire, run, key, body, flight, seen).finally(() => (READING.n -= 1));
  }

  export async function send<S>(wire: Wire<S>, run: Run, key: string, body: unknown, flight: Flight, seen: Entry[]): Promise<{ res: Response | null; step: Step }> {
    const idle = new AbortController();
    const timer = setTimeout(() => idle.abort(new Error("no word from the API in " + wire.idle / 1e3 + " s")), wire.idle);
    const st = wire.start(run.ask);
    const json = JSON.stringify(body);
    let res: Response | null = null;
    let step: Step;
    try {
      res = await fetch(wire.url, {
        method  : "POST",
        headers : wire.headers(key, run.ask),
        body    : json,
        signal  : AbortSignal.any([run.abort.signal, idle.signal]),
        timeout : false,
      } as RequestInit);
      const text = res.ok && res.body ? null : await res.text();
      const refusal = text === null ? null : wire.refusal?.(res, text) ?? null;
      const auth = res.status === 401 || res.status === 403 ? "Provider authentication failed (" + run.ask.vendor + "): " : "HTTP " + res.status + ": ";
      const why = text === null ? "" : refusal?.why ?? auth + Agent.reason(text);
      const stop = refusal === null && Agent.passing(res) ? "busy" : "down";
      step = why ? { ...Agent.fail(why, [], stop), refusal: refusal ?? undefined } : await Agent.stream(wire, run, res.body!, timer, seen, st, flight.begun);
    } catch (err: any) {
      step = Agent.fail(err.message, [], "busy");
    }
    clearTimeout(timer);
    flight.end();
    return { res, step };
  }

  // a failed request's why: the API's message (Anthropic's and OpenAI's
  // errors are {error: {message}}, the ChatGPT backend's some {detail}),
  // else the start of its body
  export function reason(body: string): string {
    try {
      const json = JSON.parse(body);
      const why = json?.error?.message ?? json?.detail;
      return typeof why === "string" ? why : body.slice(0, 2000);
    } catch {
      return body.slice(0, 2000);
    }
  }

  export function passing(res: Response): boolean {
    const should = res.headers.get("x-should-retry");
    const busy = [408, 409, 429].includes(res.status) || res.status >= 500;
    return should === "true" || (should !== "false" && busy);
  }

  // seen: what streamed, as told to the call (none once it stopped); st:
  // what it read; begun: its response began (Flight)
  export async function stream<S>(wire: Wire<S>, run: Run, body: ReadableStream<Uint8Array>, timer: Timer, seen: Entry[], st: S, begun: () => void): Promise<Step> {
    const ask = run.ask;
    const on: Emit = (kind, text, fresh) => {
      if (!run.abort.signal.aborted) {
        live_push(seen, kind, text, fresh);
        run.on({ $: "Delta", kind, text, fresh });
      }
    };
    try {
      for await (const ev of Agent.events(body)) {
        timer.refresh();
        if (wire.begun(ev)) {
          begun();
        }
        if (wire.read(st, ev, on)) {
          const step = wire.step(st, ask);
          return step.stop === "fail" || step.stop === "busy" ? Agent.fail(step.why, seen, step.stop) : step;
        }
      }
      return Agent.fail("the stream ended early", seen, "busy");
    } catch (err: any) {
      return Agent.fail(err.message, seen, "busy");
    }
  }

  export function fail(why: string, seen: Entry[], stop: Step["stop"] = "lost"): Step {
    const mark = "\n[cut off: " + (stop === "busy" ? BUSY : why).slice(0, 300) + "]";
    const entries = seen.filter((e) => e.text.trim()).map((e) => ({ kind: e.kind, text: e.text.trim() + mark }));
    return { out: [], uses: [], entries, stop, why, note: "" };
  }

  export async function* events(stream: ReadableStream<Uint8Array>) {
    for await (const line of AskAI.lines(stream)) {
      if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
        yield JSON.parse(line.slice(5));
      }
    }
  }

  // null: not JSON
  export function parse(json: string): unknown {
    try {
      return JSON.parse(json || "{}");
    } catch {
      return null;
    }
  }

  // Tools
  // -----

  export async function use(run: Run, tools: Tool[], use: Use): Promise<Out> {
    if (!tools.some((t) => t.name === use.name)) {
      return { text: "No tool " + use.name + ".", fail: true };
    }
    if (use.input === null || typeof use.input !== "object") {
      return { text: "The input is not a JSON object.", fail: true };
    }
    const got = await Agent.call(run, use.name, use.input);
    if (!got.ok) {
      return { text: run.abort.signal.aborted ? "(stopped)" : got.error().message, fail: true };
    }
    const out = got.value();
    return { ...out, text: out.text || "(no output)" };
  }

  export async function server(run: Run): Promise<Result<Tool[], Error>> {
    if (!run.ask.server) {
      return new Ok([]);
    }
    const list = await Agent.rpc(run, "tools/list", {});
    return list.ok ? new Ok(list.value().tools.map((t: any) => ({ name: t.name, info: t.description, schema: t.inputSchema }))) : list;
  }

  export async function call(run: Run, name: string, input: unknown): Promise<Result<Out, Error>> {
    const got = await Agent.rpc(run, "tools/call", { name, arguments: input });
    if (!got.ok) {
      return got;
    }
    const res = got.value();
    const pics = res.content.filter((part: any) => part.type === "image");
    const imgs = pics.map((part: any) => ({ type: part.mimeType, data: part.data }));
    return new Ok({ text: AskAI.show(res.content), fail: res.isError === true, imgs });
  }

  export async function rpc(run: Run, method: string, params: unknown): Promise<Result<any, Error>> {
    try {
      const res = await fetch(run.ask.server, {
        method  : "POST",
        headers : { "content-type": "application/json" },
        body    : JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal  : run.abort.signal,
        timeout : false,
      } as RequestInit);
      const msg = await res.json();
      return msg.error ? new Err(new Error(method + ": " + msg.error.message)) : new Ok(msg.result);
    } catch (e) {
      return caught(e);
    }
  }

}
