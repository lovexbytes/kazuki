// Computer
// ========
// The actions of the computer tool (machine.ts), Anthropic's computer use
// tool in shape, run as jobs on a device. computer.swift, carried by the
// executable and compiled into ~/.kazuki (swiftc) when missing or changed,
// does the mouse and keyboard and tells the screenshot's size;
// screencapture and sips take it as a JPEG. Every action answers with a
// screenshot taken after it; zoom with its region. wait and hold_key wait
// here, so a stop ends them. macOS needs the Screen Recording and
// Accessibility permissions of what started the terminal (over ssh: sshd).

import * as fs from "node:fs"
import * as os from "node:os"
import type {Out} from "../ai/agent.ts"
import SOURCE from "./computer.swift" with {type: "text"}
import {WAIT} from "./machine.ts"
import {nap} from "../util/nap.ts"
import {caught, Err, Ok, type Result} from "../util/result.ts"

// Types
// =====

// what computer.swift prints: the screenshot's size, its scale (screen
// points per pixel), the action's answer
type Done = {w: number; h: number; scale: number; text: string}

// Constants
// =========

const HOME = `${os.homedir()}/.kazuki`

// how long the screen gets to show the last action before a screenshot,
// in ms (Anthropic's reference computer use tool waits too)
const SETTLE = 500

// Computer
// ========

export namespace Computer {
  // a failed action is a failed tool output
  export async function act(input: any, signal: AbortSignal): Promise<Out> {
    const name = String(input.action)
    if (name === "zoom") {
      return Computer.zoom(input)
    }
    const got = await Computer.step(name, input, signal)
    if (!got.ok) {
      return {text: got.error().message, fail: true}
    }
    const done = got.value()
    await Bun.sleep(SETTLE)
    const shot = await Computer.shot([], done.w, done.h)
    return {...shot, text: `${done.text}\n${shot.text}`}
  }

  // an action, done
  export async function step(
    name: string,
    input: any,
    signal: AbortSignal
  ): Promise<Result<Done, Error>> {
    const ms = Math.max(0, Math.min(WAIT, Number(input.duration) || 0)) * 1000
    switch (name) {
      case "wait": {
        await nap(ms, signal)
        return Computer.hands(name, input)
      }
      case "hold_key": {
        const done = await Computer.hands("press", input)
        if (!done.ok) {
          return done
        }
        await nap(ms, signal)
        const released = await Computer.hands("release", input)
        return released.ok ? done : released
      }
      default: {
        return Computer.hands(name, input)
      }
    }
  }

  // the region [x0, y0, x1, y1] of the screenshot, at the screen's own
  // resolution, as large as the screenshot
  export async function zoom(input: any): Promise<Out> {
    const got = await Computer.hands("zoom", input)
    if (!got.ok) {
      return {text: got.error().message, fail: true}
    }
    const done = got.value()
    const [x0, y0, x1, y1] = (input.region ?? []).map(
      (n: number) => n * done.scale
    )
    if (!(x1 > x0 && y1 > y0)) {
      return {
        text: "region must be [x0, y0, x1, y1], with x1 > x0 and y1 > y0",
        fail: true
      }
    }
    const fit = Math.min(done.w / (x1 - x0), done.h / (y1 - y0))
    const area = [x0, y0, x1 - x0, y1 - y0].map(Math.round).join(",")
    return Computer.shot(
      ["-R", area],
      Math.round((x1 - x0) * fit),
      Math.round((y1 - y0) * fit)
    )
  }

  // an action by the helper, built first if its source changed
  export async function hands(
    name: string,
    input: unknown
  ): Promise<Result<Done, Error>> {
    const bin = `${HOME}/computer`
    const src = `${bin}.swift`
    try {
      if (
        !(fs.existsSync(bin) && fs.existsSync(src)) ||
        fs.readFileSync(src, "utf8") !== SOURCE
      ) {
        fs.mkdirSync(HOME, {recursive: true})
        fs.writeFileSync(src, SOURCE)
        const built = await Computer.exec(["swiftc", "-O", src, "-o", bin])
        if (!built.ok) {
          return new Err(built.error())
        }
      }
      const out = await Computer.exec([bin, JSON.stringify({name, input})])
      return out.ok ? new Ok(JSON.parse(out.value())) : new Err(out.error())
    } catch (e) {
      return caught(e)
    }
  }

  // the screen (or the region `opts` gives), scaled to w by h, as a JPEG
  export async function shot(
    opts: string[],
    w: number,
    h: number
  ): Promise<Out> {
    const file = `${os.tmpdir()}/kazuki-${crypto.randomUUID()}.jpg`
    try {
      const taken = await Computer.exec([
        "screencapture",
        "-x",
        "-t",
        "jpg",
        ...opts,
        file
      ])
      const sized = taken.ok
        ? await Computer.exec(["sips", "-z", String(h), String(w), file])
        : taken
      if (!sized.ok) {
        return {text: sized.error().message, fail: true}
      }
      const data = fs.readFileSync(file).toString("base64")
      return {
        text: `[image ${w}x${h}]`,
        fail: false,
        imgs: [{type: "image/jpeg", data}]
      }
    } catch (e) {
      return {text: caught(e).error().message, fail: true}
    } finally {
      fs.rmSync(file, {force: true})
    }
  }

  // a command's output; one that exits other than 0 fails, saying why
  export async function exec(argv: string[]): Promise<Result<string, Error>> {
    try {
      const proc = Bun.spawn(argv, {stdout: "pipe", stderr: "pipe"})
      const outs = [
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ]
      const [out, err] = await Promise.all(outs)
      const code = await proc.exited
      if (code !== 0) {
        return new Err(
          new Error((err || out).trim() || `${argv[0]}: exit ${code}`)
        )
      }
      return new Ok(out.trim())
    } catch (e) {
      return caught(e)
    }
  }
}
