// Mock
// ====
// A fake Anthropic (Messages API) and OpenAI (Responses API, and
// transcription) on one local port, for end-to-end runs. Each request is
// logged as a JSON line to $E2E_LOG. The answer follows the last user text
// of the request:
//   RUN: <command>   a shell tool call on the device the request names,
//                    then, once its result comes back, "ran: <result>"
//   anything else    "pong <vendor>: <the text's first line>"
// A compaction (the memory's summaries) gets a one-line summary.
//
// Usage: bun test/e2e/mock.ts [port]   (default 9711)

import * as fs from "node:fs";

const PORT = Number(process.argv[2] ?? 9711);
const LOG  = process.env.E2E_LOG ?? "/dev/null";

// Helpers
// =======

function sse(events: object[], named: boolean): Response {
  const body = events.map((ev: any) => (named ? "event: " + ev.type + "\n" : "") + "data: " + JSON.stringify(ev) + "\n\n").join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// every text in a value, in order
function texts(x: any): string[] {
  if (typeof x === "string") return [x];
  if (x && typeof x === "object" && typeof x.output === "string" && x.type === "function_call_output") return [x.output];
  if (Array.isArray(x)) return x.flatMap(texts);
  // a block's own text, else the parts that hold text (never a type, an
  // id, or a cache mark such as {"mode":"explicit"})
  if (x && typeof x === "object") {
    if (typeof x.text === "string") return [x.text];
    return ["system", "instructions", "messages", "input", "content", "output"].flatMap((k) => (k in x ? texts(x[k]) : []));
  }
  return [];
}

// the device a request names: tools.ts lists them in each call's message
// ("Devices open now:\n- <name>, work dir …"); the first one
function device(body: any): string {
  return /Devices open now:\n- ([^,\s]+),/.exec(texts(body).join("\n"))?.[1] ?? "none";
}

// the user's words in a turn's message (server/shared.ts HEAD), else the
// text whole (a compaction's task)
function said(text: string): string {
  const at = text.lastIndexOf("Turn: the user's new message:\n\n");
  return at < 0 ? text : text.slice(at + "Turn: the user's new message:\n\n".length);
}

// what to answer: a tool call to make, or a text
type Plan = { tool: { name: string; input: object } } | { text: string };

function plan(vendor: string, text: string, result: string | null, body: any): Plan {
  const turn = text.includes("Turn: the user's new message:");
  const last = said(text);
  if (!turn && result === null) {
    return { text: "e2e summary: " + last.replace(/\s+/g, " ").slice(0, 60) };
  }
  if (result !== null) {
    return { text: "ran: " + result.trim().split("\n")[0] };
  }
  const run = /RUN:\s*(.+)/.exec(last);
  if (run !== null) {
    return { tool: { name: "shell", input: { device: device(body), command: run[1].trim() } } };
  }
  return { text: "pong " + vendor + ": " + last.trim().split("\n").pop()!.slice(0, 80) };
}

// Anthropic
// =========

function anthropic(body: any): Response {
  const msgs: any[] = body.messages ?? [];
  const lastMsg = msgs[msgs.length - 1];
  const content = typeof lastMsg?.content === "string" ? [{ type: "text", text: lastMsg.content }] : lastMsg?.content ?? [];
  const tr = content.find((c: any) => c.type === "tool_result");
  const result = tr === undefined ? null : texts(tr.content).join("\n");
  const userTexts = content.filter((c: any) => c.type === "text").map((c: any) => c.text);
  const p = plan("anthropic", userTexts.join("\n") || texts(lastMsg).join("\n"), result, body);
  const start = { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } };
  if ("tool" in p) {
    return sse([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_" + Date.now(), name: p.tool.name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(p.tool.input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ], true);
  }
  return sse([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p.text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ], true);
}

// OpenAI
// ======

function openai(body: any): Response {
  const input: any[] = Array.isArray(body.input) ? body.input : [{ role: "user", content: String(body.input ?? "") }];
  const lastItem = input[input.length - 1];
  const result = lastItem?.type === "function_call_output" ? texts(lastItem.output).join("\n") || String(lastItem.output) : null;
  const lastUser = [...input].reverse().find((i) => i.role === "user");
  const p = plan("openai", texts(lastUser?.content ?? "").join("\n"), result, body);
  const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } };
  if ("tool" in p) {
    const item = { type: "function_call", id: "fc_" + Date.now(), call_id: "call_" + Date.now(), name: p.tool.name, arguments: JSON.stringify(p.tool.input), status: "completed" };
    return sse([
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [item], usage, service_tier: "default" } },
    ], true);
  }
  const item = { type: "message", id: "msg_" + Date.now(), role: "assistant", status: "completed", content: [{ type: "output_text", text: p.text, annotations: [] }] };
  return sse([
    { type: "response.created", response: { status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: p.text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage, service_tier: "default" } },
  ], true);
}

// Server
// ======

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("x-api-key") ?? req.headers.get("authorization") ?? "";
    if (url.pathname === "/v1/audio/transcriptions") {
      fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), path: url.pathname, auth }) + "\n");
      return Response.json({ text: "e2e voice words", usage: { type: "duration", seconds: 2 } });
    }
    const body = await req.json().catch(() => ({}));
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), path: url.pathname, auth, body }) + "\n");
    if (url.pathname === "/v1/messages") return anthropic(body);
    if (url.pathname === "/v1/responses") return openai(body);
    return new Response("mock: no route " + url.pathname, { status: 404 });
  },
});

console.log("mock: listening on 127.0.0.1:" + PORT);
