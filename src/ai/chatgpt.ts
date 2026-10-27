// ChatGPT
// =======
// Sign in with ChatGPT: an auth method of the openai provider
// (provider.ts, plugin.ts), a ChatGPT plan instead of an API key,
// signed in and called as Codex CLI does (openai/codex: codex-rs login,
// codex-api). Used, it runs openai's models on its own wire, without
// ultrafast nor list prices (the plan pays).
// The body is Codex's: openai's parts (openai.ts), the system prompt
// as `instructions`, no max_output_tokens. A usage limit (429) is told to
// the user as such, with its reset time (agent.ts, ask-ai.ts).
// config `chatgpt_issuer` and `chatgpt_url` point it elsewhere (tests).

import type {Ask} from "./ask-ai.ts"
import type {Emit, Item, Refusal, Tool, Wire} from "./agent.ts"
import {ChatGPTAuth, CLAIMS} from "./chatgpt-auth.ts"
import {MODELS, OpenAI, type State} from "./openai.ts"
import type {OAuth} from "./provider.ts"
import * as config from "../config.ts"

// a stream read so far, the items it gave
type Sub = State & {items: any[]}

// Constants
// =========

const RESPONSES =
  config
    .config_get("chatgpt_url", "https://chatgpt.com/backend-api/codex")
    .replace(/\/$/, "") + "/responses"

// 429s whose limit lasts, and what the user reads of each
const LIMITS: Record<string, string> = {
  usage_limit_reached: "reached its usage limit",
  usage_not_included: "doesn't include this use",
  insufficient_quota: "is out of quota"
}

// ChatGPT
// =======

export namespace ChatGPT {
  // Wire
  // ----

  // the body Codex sends, its fields in its order, of openai's parts:
  // the system prompt as `instructions` (the backend requires it), no
  // max_output_tokens, cache breakpoints nor tool-call cap
  export function body(
    ask: Ask,
    items: Item[],
    tools: Tool[],
    max: number
  ): unknown {
    const api: any = OpenAI.body({...ask, speed: "slow"}, items, tools, max)
    return {
      model: api.model,
      instructions: ask.system,
      input: api.input.slice(1).map(ChatGPT.unmark),
      tools: api.tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: api.reasoning,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      service_tier: ask.speed === "fast" ? "priority" : undefined,
      prompt_cache_key:
        "kazuki-" +
        Bun.hash(
          JSON.stringify([ask.model, ask.system, ask.blocks[0]?.text ?? ""])
        ).toString(36)
    }
  }

  // a user message without its cache breakpoints
  export function unmark(item: any): any {
    if (item.role !== "user" || !Array.isArray(item.content)) {
      return item
    }
    return {
      ...item,
      content: item.content.map(
        ({prompt_cache_breakpoint, ...part}: any) => part
      )
    }
  }

  export function headers(token: string): Record<string, string> {
    const saved = ChatGPTAuth.load()
    return {
      authorization: "Bearer " + token,
      "chatgpt-account-id":
        ChatGPTAuth.claims(token)[CLAIMS]?.chatgpt_account_id ??
        (saved.ok ? saved.value()?.tokens.account_id : undefined) ??
        "",
      "openai-beta": "responses=experimental",
      "content-type": "application/json",
      accept: "text/event-stream",
      originator: "kazuki"
    }
  }

  // one stream event, as OpenAI.read takes it; the backend's last
  // response holds no output, so its output is the items streamed
  export function read(st: Sub, ev: any, on: Emit): boolean {
    if (ev.type === "response.output_item.done") {
      st.items[ev.output_index ?? st.items.length] = ev.item
    }
    const end = OpenAI.read(st, ev, on)
    if (end && st.res !== null && !(st.res.output?.length > 0)) {
      st.res = {...st.res, output: st.items.filter(Boolean)}
    }
    return end
  }

  // a 429 at a lasting limit (null: not one): the backend's words logged,
  // ours said (which limit, the plan, when it resets)
  export function refusal(res: Response, text: string): Refusal | null {
    const err = ChatGPTAuth.json(text).error ?? {}
    const kind = [err.type, err.code].find(
      (k) => typeof k === "string" && Object.hasOwn(LIMITS, k)
    )
    if (res.status !== 429 || kind === undefined) {
      return null
    }
    const until =
      typeof err.resets_at === "number" &&
      err.resets_at > 0 &&
      err.resets_at < 1e11
        ? err.resets_at * 1000
        : undefined
    const plan =
      typeof err.plan_type === "string" &&
      /^[a-z0-9_]{1,20}$/.test(err.plan_type)
        ? " (" + err.plan_type + ")"
        : ""
    const when =
      until === undefined
        ? ""
        : "; it resets " +
          new Date(until).toISOString().slice(0, 16).replace("T", " ") +
          " UTC"
    const why =
      "ChatGPT " +
      kind +
      plan +
      when +
      ": " +
      String(err.message ?? "").slice(0, 300)
    return {
      why,
      say:
        "the ChatGPT plan" +
        plan +
        " this server runs on " +
        LIMITS[kind] +
        when,
      until
    }
  }

  export const wire: Wire<Sub> = {
    idle: 1200e3,
    url: RESPONSES,
    auth: (refused) => ChatGPTAuth.token(refused),
    headers: (token) => ChatGPT.headers(token),
    body: (ask, items, tools, max) => ChatGPT.body(ask, items, tools, max),
    start: (ask) => ({...OpenAI.wire.start(ask), items: []}),
    read: (st, ev, on) => ChatGPT.read(st, ev, on),
    begun: (ev) => ev.type === "response.output_item.added",
    step: (st, ask) => ({...OpenAI.step(st, ask), note: ""}),
    refusal: (res, text) => ChatGPT.refusal(res, text)
  }

  export const signin: OAuth = {
    type: "oauth",
    name: "ChatGPT Plus/Pro",
    signed: () => ChatGPTAuth.held(),
    login: () => ChatGPTAuth.cli([]),
    logout: () => ChatGPTAuth.logout(),
    wire: ChatGPT.wire,
    models: MODELS.map((m) => ({
      ...m,
      speeds: m.speeds?.filter((s) => s !== "ultrafast")
    })),
    ttl: 300e3 // the backend tells none: the shorter guess
  }
}

if (import.meta.main) {
  const got = await ChatGPTAuth.cli(process.argv.slice(2))
  if (!got.ok) {
    console.error(got.error().message)
    process.exit(1)
  }
}
