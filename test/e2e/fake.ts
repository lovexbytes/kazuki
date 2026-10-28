// Fake
// ====
// Fake vendors for end-to-end runs: `fake("anthropic")` (the Messages API)
// or `fake("openai")` (the Responses API, the ChatGPT plan's too), each a
// real HTTP server on a free local port, in the test's own process.
// Kazuki's provider code reaches it by the provider's address in
// auth.json (kit.ts writes it), as it reaches the real one.
//
// Each request is read into one shape for both formats (Seen: the model,
// the key, the system prompt, the tool names, the messages as text, calls
// and results) and kept, for the test to check. The answer is a list of
// steps (a text, a tool call), written as the format's stream. The steps
// follow the request's last message:
//   a tool's result        "ran: <its first line>"
//   a turn: "RUN: <cmd>"   a shell tool call on the device the request names
//   a turn: anything else  "pong <vendor>: <the message's last line>"
//   no turn                a one-line summary (a compaction)

import * as fs from "node:fs"

// Types
// =====

export type Vendor = "anthropic" | "openai"

export type Msg =
  | {role: "user" | "assistant"; text: string}
  | {role: "call"; name: string; input: any}
  | {role: "result"; text: string}

export type Seen = {
  path: string
  auth: string
  model: string
  system: string
  tools: string[]
  messages: Msg[]
  body: any
}

export type Step = {text: string} | {tool: {name: string; input: object}}

export type Fake = {url: string; seen: () => Seen[]; stop: () => void}

// Constants
// =========

// what opens the user's words in a turn's message (server/shared.ts)
const TURN = "Turn: the user's new message:\n\n"

// Fake
// ====

// a fake vendor; each request it reads is also a JSON line in `log`
export function fake(vendor: Vendor, log = "/dev/null"): Fake {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("fake: POST only", {status: 404})
      }
      const auth =
        req.headers.get("x-api-key") ?? req.headers.get("authorization") ?? ""
      const body = await req.json()
      const s = {path: new URL(req.url).pathname, auth, ...READ[vendor](body)}
      seen.push(s)
      fs.appendFileSync(log, `${JSON.stringify(s)}\n`)
      return sse(WRITE[vendor](reply(vendor, s)))
    }
  })
  return {
    url: server.url.href.replace(/\/$/, ""),
    seen: () => seen,
    stop: () => server.stop(true)
  }
}

// the steps that answer a request
function reply(vendor: Vendor, s: Seen): Step[] {
  const last = s.messages.at(-1)
  if (last?.role === "result") {
    return [{text: `ran: ${last.text.trim().split("\n")[0]}`}]
  }
  const text = last?.role === "user" ? last.text : ""
  const at = text.lastIndexOf(TURN)
  if (at < 0) {
    return [{text: `e2e summary: ${text.replace(/\s+/g, " ").slice(0, 60)}`}]
  }
  const said = text.slice(at + TURN.length).trim()
  const run = /RUN:\s*(.+)/.exec(said)
  if (run !== null) {
    // tools.ts lists the devices in each turn ("Devices open now:\n- <name>,")
    const device = /Devices open now:\n- ([^,\s]+),/.exec(text)?.[1] ?? "none"
    return [{tool: {name: "shell", input: {device, command: run[1].trim()}}}]
  }
  return [{text: `pong ${vendor}: ${said.split("\n").at(-1)?.slice(0, 80)}`}]
}

function sse(events: any[]): Response {
  const body = events
    .map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    .join("")
  return new Response(body, {headers: {"content-type": "text/event-stream"}})
}

// every text in a value, in order
function texts(x: any): string[] {
  if (typeof x === "string") {
    return [x]
  }
  if (Array.isArray(x)) {
    return x.flatMap(texts)
  }
  return typeof x?.text === "string" ? [x.text] : []
}

type Read = (body: any) => Omit<Seen, "path" | "auth">

// Anthropic
// =========

function anthropic_read(body: any): ReturnType<Read> {
  return {
    model: body.model,
    system: texts(body.system).join(""),
    tools: (body.tools ?? []).map((t: any) => t.name),
    messages: body.messages.flatMap((m: any): Msg[] => {
      const blocks =
        typeof m.content === "string"
          ? [{type: "text", text: m.content}]
          : m.content
      const text = texts(blocks.filter((b: any) => b.type === "text")).join("")
      return [
        ...(text === "" ? [] : [{role: m.role, text}]),
        ...blocks.flatMap((b: any): Msg[] => {
          if (b.type === "tool_use") {
            return [{role: "call", name: b.name, input: b.input}]
          }
          if (b.type === "tool_result") {
            return [{role: "result", text: texts(b.content).join("")}]
          }
          return []
        })
      ]
    }),
    body
  }
}

function anthropic_write(steps: Step[]): object[] {
  const blocks = steps.flatMap((step, index) => [
    {
      type: "content_block_start",
      index,
      content_block:
        "text" in step
          ? {type: "text", text: ""}
          : {
              type: "tool_use",
              id: `toolu_${index}`,
              name: step.tool.name,
              input: {}
            }
    },
    {
      type: "content_block_delta",
      index,
      delta:
        "text" in step
          ? {type: "text_delta", text: step.text}
          : {
              type: "input_json_delta",
              partial_json: JSON.stringify(step.tool.input)
            }
    },
    {type: "content_block_stop", index}
  ])
  const tool = steps.some((step) => "tool" in step)
  return [
    {
      type: "message_start",
      message: {usage: {input_tokens: 100, output_tokens: 1}}
    },
    ...blocks,
    {
      type: "message_delta",
      delta: {stop_reason: tool ? "tool_use" : "end_turn"},
      usage: {output_tokens: 20}
    },
    {type: "message_stop"}
  ]
}

// OpenAI
// ======

function openai_read(body: any): ReturnType<Read> {
  const input: any[] = body.input
  // the system prompt comes as instructions, or as a developer message
  const dev = input.filter((i) => i.role === "developer" || i.role === "system")
  return {
    model: body.model,
    system: [
      body.instructions ?? "",
      ...dev.flatMap((i) => texts(i.content))
    ].join(""),
    tools: (body.tools ?? []).map((t: any) => t.name ?? t.type),
    messages: input.flatMap((i): Msg[] => {
      if (i.type === "function_call") {
        return [{role: "call", name: i.name, input: JSON.parse(i.arguments)}]
      }
      if (i.type === "function_call_output") {
        return [{role: "result", text: texts(i.output).join("")}]
      }
      if (i.role === "user" || i.role === "assistant") {
        return [{role: i.role, text: texts(i.content).join("")}]
      }
      return []
    }),
    body
  }
}

function openai_write(steps: Step[]): object[] {
  const items = steps.map((step, i) =>
    "text" in step
      ? {
          type: "message",
          id: `msg_${i}`,
          role: "assistant",
          status: "completed",
          content: [{type: "output_text", text: step.text, annotations: []}]
        }
      : {
          type: "function_call",
          id: `fc_${i}`,
          call_id: `call_${i}`,
          name: step.tool.name,
          arguments: JSON.stringify(step.tool.input),
          status: "completed"
        }
  )
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: {cached_tokens: 0}
  }
  return [
    {type: "response.created", response: {status: "in_progress"}},
    ...items.flatMap((item, output_index) => [
      {
        type: "response.output_item.added",
        output_index,
        item:
          item.type === "message"
            ? {...item, content: []}
            : {...item, arguments: ""}
      },
      item.type === "message"
        ? {
            type: "response.output_text.delta",
            output_index,
            delta: item.content?.[0].text
          }
        : {
            type: "response.function_call_arguments.delta",
            output_index,
            delta: item.arguments
          },
      {type: "response.output_item.done", output_index, item}
    ]),
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: items,
        usage,
        service_tier: "default"
      }
    }
  ]
}

const READ: Record<Vendor, Read> = {
  anthropic: anthropic_read,
  openai: openai_read
}
const WRITE: Record<Vendor, (steps: Step[]) => object[]> = {
  anthropic: anthropic_write,
  openai: openai_write
}
