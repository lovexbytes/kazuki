// Turn
// ====
// A /model while the turn's call runs: the wait names the model the
// running call asked, not the one picked since. Run by server.test.ts in
// its own process (config is read once a process), with KAZUKI_DIR set;
// prints one JSON line.

import {AskAI} from "../../src/ai/ask-ai.ts"
import {Cloud} from "../../src/core/cloud.ts"
import {Plugin} from "../../src/core/plugin.ts"
import {Chat} from "../../src/core/server/chat.ts"
import {Views} from "../../src/core/server/views.ts"
import {noop} from "../../src/util/noop.ts"

// a call that never ends
const ask: typeof AskAI.ask = (_ask, on) => AskAI.tie(on, noop, noop)[0]

Plugin.load()
Chat.cloud = Cloud.open(noop)
Object.assign(AskAI, {ask})
const chat = Chat.open({id: "u1", name: "a@b.c"})
if (chat === null) {
  throw new Error("the chat did not open")
}
Chat.take(chat, Chat.push(chat, null, "user", "hi"))
await Bun.sleep(10)
const model = chat.pick.model
const waited = Views.waits(chat)
const to = {
  ...chat.pick,
  model: model === "opus-5.5" ? "haiku-5.5" : "opus-5.5"
}
const acted = (await Views.act(chat, "pick", {$: "pick", to}, "")).ok
console.log(
  JSON.stringify({
    model,
    waited,
    acted,
    picked: chat.pick.model,
    to: to.model,
    after: Views.waits(chat)
  })
)
process.exit(0)
