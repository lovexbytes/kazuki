// main
// ====
// Opens the terminal's chat on a server (its url): in a terminal, the
// app (app.tsx) on the alternate screen; from a pipe, each line a
// message, Kazuki's answers printed as they are logged, till the input
// ends and no work runs. KAZUKI_THEME (light, dark) sets the colors
// where the terminal doesn't say its own.

import {createCliRenderer} from "@opentui/core"
import {render} from "@opentui/solid"
import * as Call from "../view/call.ts"
import {Machine} from "../device/machine.ts"
import * as View from "../view/view.ts"
import {App} from "./app.tsx"
import {
  client_close,
  client_connect,
  client_new,
  client_say,
  type Client
} from "./client.ts"
import {cmd_run} from "./commands.ts"
import {DARK, LIGHT} from "./palette.ts"

export type Opts = {url: string; device: string; work: string; screen: boolean}

// the signals that end it; however it ends, the jobs it ran end too
// (machine.ts: their process groups)
const SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT", "SIGQUIT", "SIGPIPE"] as const

export async function tui_run(o: Opts): Promise<void> {
  const c = client_new(o.url, o.device, o.work, o.screen)
  process.on("exit", () => Machine.end())
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return pipe_run(c)
  }
  const r = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    useMouse: true,
    useKittyKeyboard: {},
    autoFocus: false
  })
  const set = process.env.KAZUKI_THEME
  const mode =
    set === "light" || set === "dark"
      ? set
      : await r.waitForThemeMode(300).catch(() => null)
  const p = mode === "light" ? LIGHT : DARK
  r.setTerminalTitle("Kazuki")
  let done = false
  const quit = () => {
    if (done) {
      return
    }
    done = true
    client_close(c)
    try {
      r.destroy()
    } catch {
      // the terminal may be gone (a hangup): nothing to restore then
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 50)
  }
  for (const sig of SIGNALS) {
    process.on(sig, quit)
  }
  await render(() => <App c={c} p={p} quit={quit} />, r)
  client_connect(c)
}

// Pipe
// ====

// each line read, sent (or run, a command); what is logged printed as
// plain text: Kazuki's words, a call's line, an agent's report, a note;
// a message refused ends it, failed
async function pipe_run(c: Client): Promise<void> {
  let ended = false
  let last = -1
  const idle = () => {
    // nothing left to send, run or answer: a link lost then keeps it no
    // longer
    if (
      ended &&
      c.pending <= 0 &&
      c.v.out.length === 0 &&
      !View.view_running(c.v)
    ) {
      client_close(c)
      process.exit(process.exitCode ?? 0)
    }
  }
  c.hooks.note = (text) => console.error(text)
  c.hooks.sheet = (title, md) => console.log(`# ${title}\n\n${md}\n`)
  c.hooks.back = () => {
    client_close(c)
    process.exit(1)
  }
  for (const sig of SIGNALS) {
    process.on(sig, () => {
      client_close(c)
      process.exit(1)
    })
  }
  c.hooks.quit = () => {
    ended = true
    idle()
  }
  c.hooks.pick = (move) => console.error(`/${move} <${move}> picks one.`)
  // a command reads the chat (its pick, its blocks): no line is taken
  // before both came; a server never reached keeps the pipe waiting
  const view = Promise.withResolvers<void>()
  c.heard.push((msg) => {
    if (msg.$ === "view" && last < 0) {
      last = View.view_count(c.v) - 1
    }
    if (last >= 0 && c.v.pick !== null) {
      view.resolve()
    }
    if (
      msg.$ === "entry" &&
      msg.agent === undefined &&
      msg.id !== undefined &&
      msg.id > last
    ) {
      last = msg.id
      const line = pipe_line(msg.kind, msg.text)
      if (line !== "") {
        console.log(`${line}\n`)
      }
    }
    if (msg.$ === "state") {
      idle()
    }
  })
  client_connect(c)
  setInterval(idle, 250)
  const take = (line: string) => {
    if (
      line.trim() !== "" &&
      !(line.trim().startsWith("/") && cmd_run(c, line))
    ) {
      client_say(c, line)
    }
  }
  // a character cut between chunks waits for its rest
  const dec = new TextDecoder()
  let buf = ""
  await view.promise
  for await (const chunk of process.stdin) {
    buf += dec.decode(chunk, {stream: true})
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    lines.forEach(take)
  }
  take(buf)
  ended = true
}

// a logged message as a line of plain text ("": not printed)
function pipe_line(kind: string, text: string): string {
  switch (kind) {
    case "unii":
      return text.trim()
    case "work":
      return (Call.report_read(text)?.text ?? text).trim()
    case "note":
      return `· ${text.trim()}`
    case "tool": {
      const call = Call.call_parse(text)
      return `→ ${(`${call.name} ${Call.call_line(call)}`).trim()}`
    }
    default:
      return ""
  }
}
