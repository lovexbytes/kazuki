// Resume
// ======
// An import paused stays paused once its chat opens again (import.json
// keeps why); one not paused (why null) goes on, though a chat loads
// paused. Run by server.test.ts in its own process, with KAZUKI_DIR set;
// prints one JSON line.

import * as fs from "node:fs"
import {AskAI} from "../../src/ai/ask-ai.ts"
import {Cloud} from "../../src/core/cloud.ts"
import {Memory, type Share} from "../../src/core/memory.ts"
import {Plugin} from "../../src/core/plugin.ts"
import {type Chat as Open, Chat} from "../../src/core/server/chat.ts"
import {Ingest} from "../../src/core/server/ingest.ts"
import {Views} from "../../src/core/server/views.ts"
import {noop} from "../../src/util/noop.ts"

const DIR = process.env.KAZUKI_DIR
// what the summaries would be asked with; none is, the calls never end
const SHARE: Share = {
  vendor: "anthropic",
  model: "claude-opus-5-5",
  system: "",
  searches: 0,
  server: ""
}

// a call that never ends
const ask: typeof AskAI.ask = (_ask, on) => AskAI.tie(on, noop, noop)[0]
const file = (id: string) => `${DIR}/users/${id}/import.json`
const why = (id: string) => JSON.parse(fs.readFileSync(file(id), "utf8")).why

function open(id: string, name: string): Open {
  const chat = Chat.open({id, name})
  if (chat === null) {
    throw new Error(`chat ${id} did not open`)
  }
  return chat
}

// the import's pause, as a view shows it
function shown(chat: Open): string | null | undefined {
  const state = Views.state(chat)
  return state.$ === "state" ? state.importing?.why : undefined
}

Plugin.load()
Chat.cloud = Cloud.open(noop)
Object.assign(AskAI, {ask})
// each imports 2 messages too long to summarize with no call, its calls
// never ending, so it still runs at the reads
for (const [id, saved] of [
  ["u1", "paused"],
  ["u2", null]
] as const) {
  fs.mkdirSync(`${DIR}/users/${id}`, {recursive: true})
  Memory.push(
    Memory.load(`${DIR}/users/${id}`, () => SHARE),
    [
      {kind: "user", text: "hi ".repeat(9999)},
      {kind: "kazuki", text: "hello ".repeat(9999)}
    ]
  )
  fs.writeFileSync(file(id), JSON.stringify({a: 0, b: 2, said: 2, why: saved}))
}
const held = open("u1", "a")
const goes = open("u2", "b")
await Bun.sleep(10)
console.log(
  JSON.stringify({
    held: shown(held),
    goes: shown(goes),
    paused: [held.mem.paused, goes.mem.paused],
    on: Ingest.go(held, true).ok,
    went: why("u1"),
    off: Ingest.go(held, false).ok,
    kept: why("u1")
  })
)
process.exit(0)
