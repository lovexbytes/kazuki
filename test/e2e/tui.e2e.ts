// TUI
// ===
// The terminal app (`kazuki tui`) in tmux, as a person uses it, against a
// server on fake vendors: the chat drawn, a message typed, /help, the
// model picker, a tool call's card, /stop, a server restart, Ctrl+D. The
// screens land in $E2E/tui/screen-*.txt. The tests run in order, on one
// chat.

import {beforeAll, expect, test} from "bun:test"
import * as fs from "node:fs"
import {open, say, sh, until} from "./kit.ts"

const kit = open("tui")

const tmux = (args: string[]) =>
  sh(["tmux", "-L", `kazuki-e2e-${new URL(kit.url).port}`, ...args])
const pane = () => tmux(["capture-pane", "-p", "-t", "e2e"]).out
const keys = (...k: string[]) => tmux(["send-keys", "-t", "e2e", ...k])
const type = (text: string) => {
  tmux(["send-keys", "-t", "e2e", "-l", text])
  keys("Enter")
}
// the footer's line (it shows the server's address)
const footer = () =>
  pane()
    .split("\n")
    .filter((l) => l.includes("127.0.0.1:"))
    .join("")
// the screen (or its footer) once it shows what is asked, or as it is
// when the wait ends
const shows = async (what: string | RegExp, ms = 20e3, screen = pane) => {
  let seen = screen()
  await until(() => {
    seen = screen()
    return typeof what === "string" ? seen.includes(what) : what.test(seen)
  }, ms)
  return seen
}
const shot = (name: string) =>
  fs.writeFileSync(`${kit.dir}/screen-${name}.txt`, pane())
// an Esc alone waits out the terminal's escape-sequence time first
const esc = async () => {
  await Bun.sleep(300)
  keys("Escape")
}

// a chat to open on: a message on gpt-6-luna, from the pipe
beforeAll(async () => {
  await say(kit, ["/model gpt-6-luna"])
  await say(kit, ["before tui"])
  tmux(["kill-server"])
  const env = Object.entries(kit.env).map(
    ([k, v]) => `${k}=${JSON.stringify(v)}`
  )
  tmux([
    "new-session",
    "-d",
    "-s",
    "e2e",
    "-x",
    "140",
    "-y",
    "45",
    `env -i TERM=xterm-256color ${env.join(" ")} bun src/cli.ts tui`
  ])
})

test("tui: opens and draws the chat", async () => {
  expect(await shows("pong openai: before tui", 15e3)).toContain(
    "pong openai: before tui"
  )
})

test("tui: the footer shows the pick", async () => {
  expect(await shows("gpt-6-luna", 20e3, footer)).toContain("gpt-6-luna")
})

test("tui: a typed message gets its reply", async () => {
  type("hello from tui")
  expect(await shows("pong openai: hello from tui")).toContain(
    "pong openai: hello from tui"
  )
})

// /help: a sheet over the page, closed by Esc
test("tui: /help opens a sheet of commands and keys", async () => {
  type("/help")
  const help = /Keys[\s\S]*Ctrl\+O|\/model/
  expect(await shows(help)).toMatch(help)
  shot("help")
})

test("tui: Esc closes the sheet", async () => {
  await esc()
  await until(() => !pane().includes("─ Help ─"), 5e3)
  expect(pane()).not.toContain("─ Help ─")
  await Bun.sleep(300)
})

// the model picker (Ctrl+P), and /model with a name
const listed = /sonnet-5\.5[\s\S]*haiku-5\.5|haiku-5\.5[\s\S]*sonnet-5\.5/

test("tui: Ctrl+P lists the models", async () => {
  keys("C-p")
  expect(await shows(listed, 10e3)).toMatch(listed)
  shot("picker")
})

test("tui: Esc closes the picker", async () => {
  await esc()
  await until(() => !listed.test(pane()), 5e3)
  expect(pane()).not.toMatch(listed)
  await Bun.sleep(300)
})

test("tui: /model changes the footer", async () => {
  type("/model sonnet-5.5")
  expect(await shows("sonnet-5.5", 20e3, footer)).toContain("sonnet-5.5")
})

test("tui: the next turn runs on the model picked", async () => {
  const before = kit.anthropic.seen().length
  type("on sonnet")
  expect(await shows("pong anthropic: on sonnet")).toContain(
    "pong anthropic: on sonnet"
  )
  expect(
    kit.anthropic
      .seen()
      .slice(before)
      .map((s) => s.model)
  ).toContain("claude-sonnet-5-5")
})

test("tui: Shift+Right steps to the next model", async () => {
  keys("S-Right")
  await until(() => !/sonnet-5\.5\s+medium/.test(footer()), 5e3)
  expect(footer()).not.toMatch(/sonnet-5\.5\s+medium/)
})

test("tui: back on gpt-6-luna", async () => {
  type("/model gpt-6-luna")
  expect(await shows(/gpt-6-luna\s+medium/)).toMatch(/gpt-6-luna\s+medium/)
})

// a tool call while you watch: its card runs, then its folded output
// opens whole with Ctrl+O
test("tui: a running tool call shows its card", async () => {
  type("RUN: sleep 2; seq 1 40")
  const card = /\$ (Shell )?sleep 2; seq 1 40/
  expect(await shows(card, 10e3)).toMatch(card)
})

test("tui: the tool's reply comes after it", async () => {
  expect(await shows("ran: 1")).toContain("ran: 1")
})

test("tui: Ctrl+O opens the tool's output whole", async () => {
  expect(pane()).toContain("lines above")
  keys("C-o")
  await until(() => !pane().includes("lines above"), 5e3)
  expect(pane()).not.toContain("lines above")
  shot("ctrl-o")
  keys("C-o")
})

// /stop cuts a running tool: its shell dies, the next message works.
// The sleep's length is this run's own, so another run's is never taken
// for it.
const nap = () => `sleep 45.${new URL(kit.url).port}`
const sleeping = () => sh(["pgrep", "-f", `^${nap().replace(".", "\\.")}$`]).ok

test("tui: the long tool runs here", async () => {
  type(`RUN: ${nap()}`)
  await shows("sleep 45", 10e3)
  expect(await until(sleeping, 5e3)).toBe(true)
})

test("tui: /stop kills the tool's process", async () => {
  type("/stop")
  expect(await until(() => !sleeping(), 10e3)).toBe(true)
})

test("tui: a message after /stop gets its reply", async () => {
  type("after stop")
  expect(await shows("pong openai: after stop")).toContain(
    "pong openai: after stop"
  )
})

// the server restarts while the terminal is open: it links again
test("tui: reconnects after the server restarts", async () => {
  await kit.restart()
  type("after server restart")
  expect(await shows("pong openai: after server restart", 30e3)).toContain(
    "pong openai: after server restart"
  )
  shot("end")
})

// Ctrl+D on an empty input quits; the chat goes on without it
test("tui: Ctrl+D quits", async () => {
  keys("C-d")
  expect(await until(() => !tmux(["has-session", "-t", "e2e"]).ok, 5e3)).toBe(
    true
  )
  tmux(["kill-server"])
})
