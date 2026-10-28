// Pipe
// ====
// The pipe client (`echo hi | kazuki`) against a server on fake vendors:
// both formats, a tool call run on this device, the server's keys kept
// from its jobs, the compactor, a restart, a /command piped first. The
// tests run in order, on one chat.

import {expect, test} from "bun:test"
import * as fs from "node:fs"
import {open, say, until} from "./kit.ts"

const kit = open("pipe")
// the models Anthropic was asked for, from its from-th request on
const models = (from: number) =>
  kit.anthropic
    .seen()
    .slice(from)
    .map((s) => s.model)
let out = ""

test("serves /api/me", async () => {
  expect((await fetch(`${kit.url}/api/me`)).ok).toBe(true)
})

// Anthropic: a reply, a tool call run on this device
test("anthropic: a reply streams back", async () => {
  expect(await say(kit, ["hello e2e"])).toContain("pong anthropic: hello e2e")
})

test("anthropic: asked with the dummy key", () => {
  const auth = kit.anthropic.seen().map((s) => s.auth)
  expect(auth.length).toBeGreaterThan(0)
  expect(auth.filter((a) => a !== "e2e-anthropic-dummy")).toEqual([])
})

test("anthropic: shell tool call shown", async () => {
  out = await say(kit, ["RUN: echo e2e-anthropic-tool && pwd"])
  expect(out).toContain("→ shell echo e2e-anthropic-tool")
})

test("anthropic: tool result goes back to the model", () => {
  expect(out).toContain("ran: e2e-anthropic-tool")
  expect(kit.anthropic.seen().at(-1)?.messages.at(-1)).toMatchObject({
    role: "result",
    text: expect.stringContaining("e2e-anthropic-tool")
  })
})

test("tool runs in the e2e work dir", () => {
  expect(fs.existsSync(`${kit.env.KAZUKI_WORK}/main`)).toBe(true)
})

// the server's keys stay on the server: a job runs in its terminal's own
// environment (machine.ts), and a client's has no keys
test("a job gets none of the server's keys", async () => {
  expect(
    await say(kit, ["RUN: echo keys=$(env | grep -c _API_KEY)"])
  ).toContain("ran: keys=0")
})

// a long message: the compactor (the provider's cheapest) summarizes it
test("compactor runs on the cheapest model", async () => {
  const before = kit.anthropic.seen().length
  await say(kit, [`long ${"words to compact ".repeat(80)}`])
  await until(() => models(before).includes("claude-haiku-5-5"), 15e3)
  expect(models(before)).toContain("claude-haiku-5-5")
})

// OpenAI: pick a model of its, a reply, a tool call
test("openai: a reply after /model", async () => {
  await say(kit, ["/model gpt-6-luna"])
  expect(await say(kit, ["hello openai"])).toContain(
    "pong openai: hello openai"
  )
})

test("openai: Responses API asked with the dummy key", () => {
  const seen = kit.openai.seen()
  expect(seen.map((s) => s.path)).toContain("/v1/responses")
  expect(seen.filter((s) => s.auth !== "Bearer e2e-openai-dummy")).toEqual([])
})

test("openai: asked for gpt-6-luna", () => {
  expect(kit.openai.seen().map((s) => s.model)).toContain("gpt-6-luna")
})

test("openai: tool call and result", async () => {
  out = await say(kit, ["RUN: echo e2e-openai-tool"])
  expect(out).toContain("→ shell echo e2e-openai-tool")
  expect(out).toContain("ran: e2e-openai-tool")
})

// a restart keeps the chat: the next call's view has the old messages
test("after a restart: reply on the saved pick", async () => {
  await kit.restart()
  expect(await say(kit, ["after restart"])).toContain(
    "pong openai: after restart"
  )
})

test("after a restart: the view holds the earlier chat", () => {
  const view = kit.openai
    .seen()
    .at(-1)
    ?.messages.map((m) => ("text" in m ? m.text : ""))
  expect(view?.join("\n")).toContain("hello e2e")
  expect(view?.join("\n")).toContain("hello openai")
})

// a command piped as the first line applies, though it comes before the
// view has the server's state
test("a /command as the first piped line applies", async () => {
  await say(kit, ["/model haiku-5.5"], 30e3)
  const before = kit.anthropic.seen().length
  await say(kit, ["which model"])
  expect(models(before)).toContain("claude-haiku-5-5")
})
