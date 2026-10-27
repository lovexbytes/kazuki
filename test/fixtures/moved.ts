// Moved
// =====
// A chat open as its provider disconnects runs, from its next turn, on a
// model connected now, and says so. Run by server.test.ts in its own
// process, with KAZUKI_DIR set; prints one JSON line.

import * as config from "../../src/config.ts"
import {Cloud} from "../../src/core/cloud.ts"
import {Plugin} from "../../src/core/plugin.ts"
import {Chat} from "../../src/core/server/chat.ts"
import {noop} from "../../src/util/noop.ts"

Plugin.load()
Chat.cloud = Cloud.open(noop)
config.SECRETS.set("ANTHROPIC_API_KEY", "test")
config.SECRETS.set("OPENAI_API_KEY", "test")
const chat = Chat.open({id: "u1", name: "a"})
if (chat === null) {
  throw new Error("the chat did not open")
}
const was = chat.pick.vendor
config.SECRETS.set("ANTHROPIC_API_KEY", "")
Chat.repick(chat)
console.log(
  JSON.stringify({
    was,
    now: chat.pick.vendor,
    saved: (chat.mem.pick as {vendor: string} | null)?.vendor,
    told: chat.mem.count > 2
  })
)
process.exit(0)
