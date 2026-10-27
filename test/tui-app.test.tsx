import {expect, test} from "bun:test"
import {testRender} from "@opentui/solid"
import {App} from "../src/tui/app.tsx"
import {client_new} from "../src/tui/client.ts"
import {DARK} from "../src/tui/palette.ts"
import {noop} from "../src/util/noop.ts"

// the whole page, drawn headless, with no server to reach
async function page() {
  const c = client_new("http://127.0.0.1:9", "test", "/tmp", false)
  return testRender(() => <App c={c} p={DARK} quit={noop} />, {
    width: 100,
    height: 30
  })
}

test("the page draws: the chat, the link's state, the input, the footer", async () => {
  await using t = await page()
  const frame = await t.waitForFrame((f) => f.includes("Message Kazuki"))
  expect(frame).toContain("Kazuki is an AI")
  expect(frame).toContain("offline · reconnecting")
  expect(frame).toContain("127.0.0.1:9")
})

test("typing goes to the input; a slash lists the commands", async () => {
  await using t = await page()
  await t.waitForFrame((f) => f.includes("Message Kazuki"))
  await t.mockInput.typeText("/he")
  const frame = await t.waitForFrame((f) => f.includes("/help"))
  expect(frame).toContain("every command and key")
})
