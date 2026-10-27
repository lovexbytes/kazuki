// Import
// ------
// an import: the messages of a body logged, summarized and shown.

import * as fs from "node:fs"
import {type Kind} from "../../ai/ask-ai.ts"
import * as Import from "../../import/import.ts"
import {JOBS, Memory, type Msg as Log} from "../memory.ts"
import {type Done} from "../../view/view.ts"
import {Err, Ok} from "../../util/result.ts"
import {Body, Kept, Batch, BATCH} from "./shared.ts"
import {Chat} from "./chat.ts"
import {Views} from "./views.ts"

export namespace Ingest {
  // an import (its body: messages as JSON lines), those new (fresh) logged
  // as one, summarized on the compactor; refused amid a turn or an
  // import
  export async function ingest(
    chat: Chat,
    id: string,
    body: Body
  ): Promise<Done> {
    if (chat.busy || chat.batch !== null) {
      return new Err(
        new Error(
          (chat.busy ? "Kazuki is answering" : "An import is under way") +
            ": import again once it ends."
        )
      )
    }
    const done = Ingest.done(chat)
    const sizes: number[] = []
    let said = 0
    for await (const msgs of Ingest.fresh(body, done)) {
      sizes.push(...msgs.map(Import.import_size))
      said += msgs.filter((m) => m.kind !== "note").length
    }
    const a = chat.mem.count
    if (sizes.length === 0) {
      return new Err(new Error("Nothing to import: no new messages found."))
    }
    chat.mem.paused = false
    const tag = (m: Log, of: boolean): Log => ({
      ...m,
      imported: true,
      ...(of ? {more: true} : {more: false, act: id})
    })
    let held: Log[] = []
    for await (const msgs of Ingest.fresh(body, done)) {
      const all = [...held, ...msgs]
      held = all.splice(-1)
      Memory.push(
        chat.mem,
        all.map((m) => tag(m, true))
      )
    }
    Memory.push(
      chat.mem,
      held.map((m) => tag(m, false))
    )
    chat.batch = Ingest.batch(chat, {a, b: chat.mem.count, said})
    chat.socks.forEach((sock) => Views.show(chat, sock))
    Ingest.progress(chat)
    return new Ok({going: chat.batch !== null})
  }

  // an import run: its estimate, of its messages' sizes as logged, timed
  // with none built, then its summaries built counted
  export function batch(chat: Chat, {a, b, said}: Kept): Batch {
    const sizes = Array.from(
      {length: b - a},
      (_, k) => Memory.message(chat.mem, a + k)?.size ?? 0
    )
    const micros = Import.import_guess(a, sizes)
    const batch = {
      a,
      b,
      said,
      micros,
      open: micros.map((level) => level.length),
      left: micros.flat().reduce((x, y) => x + y, 0),
      all: 0
    }
    batch.all = Ingest.time(batch)
    micros.forEach((level, l) =>
      level.forEach(
        (_, j) =>
          Memory.node(chat.mem, {l, i: Math.floor(a / 2 ** l) + j}) !== null &&
          Ingest.built(batch, l, j)
      )
    )
    return batch
  }

  // node j of level l built (none such: the chat's)
  export function built(batch: Batch, l: number, j: number): void {
    const cost = batch.micros[l]?.[j]
    if (cost !== undefined) {
      batch.left -= cost
      batch.open[l] -= 1
    }
  }

  // its time left in micro-USD (a call's, as its cost, is its thinking):
  // its cost left over JOBS, then each level not built's last call (the
  // tree's top builds a call a level)
  export function time(batch: Batch): number {
    return (
      batch.left / JOBS +
      batch.micros.reduce(
        (t, level, l) => t + (batch.open[l] > 0 ? level.at(-1)! : 0),
        0
      )
    )
  }

  // kept as it is till it ends (a restart changes nothing): written
  // whole, then moved in place
  export function keep(batch: Batch, chat: Chat): void {
    const file = chat.mem.dir + BATCH
    const {a, b, said} = batch
    fs.writeFileSync(
      file + ".new",
      JSON.stringify({a, b, said, why: chat.mem.paused ? "paused" : null})
    )
    fs.renameSync(file + ".new", file)
  }

  // the import a chat ran when let go (BATCH); null: none
  export function resumed(chat: Chat): Batch | null {
    const file = chat.mem.dir + BATCH
    if (!fs.existsSync(file)) {
      return null
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8"))
    chat.mem.paused = saved.why === "paused"
    return Ingest.batch(chat, saved)
  }

  // a body's JSON lines, as messages imported (a line is a page)
  export async function* reads(body: Body): AsyncGenerator<Log[]> {
    for await (const [lines] of Chat.pieces(body, 0, (text) =>
      text.split("\n")
    )) {
      yield lines
        .filter((line) => line !== "")
        .map((line) => Ingest.imported(JSON.parse(line)))
    }
  }

  // a body's messages new to the chat (Import.import_new): a session
  // imported before brings only what came after, its note only then
  export async function* fresh(
    body: Body,
    done: Import.Done
  ): AsyncGenerator<Log[]> {
    let note: Log | null = null
    let last: string | undefined
    for await (const msgs of Ingest.reads(body)) {
      const out: Log[] = []
      for (const m of msgs) {
        if (m.kind === "note") {
          ;[note, last] = [m, done[Import.import_key(m)]]
        } else if (Import.import_new(m, last)) {
          out.push(...(note === null ? [] : [note]), m)
          note = null
        }
      }
      yield out
    }
  }

  // the sessions the chat imported (Import.Done), read from its log
  export function done(chat: Chat): Import.Done {
    const done: Import.Done = {}
    let key = ""
    for (let i = 0; i < chat.mem.count; i++) {
      const m = Memory.message(chat.mem, i)!
      if (m.imported && m.kind === "note") {
        key = Import.import_key(m)
      } else if (m.imported && m.date > (done[key] ?? "")) {
        done[key] = m.date
      }
    }
    return done
  }

  // a message imported (a page); a line with no kind or no text refuses
  // the import whole (ingest reads every line before it logs one)
  export function imported(x: any): Log {
    const kinds: Kind[] = ["user", "unii", "tool", "echo", "note"]
    if (!kinds.includes(x?.kind)) {
      throw new Error("An import has no kind " + x?.kind + ".")
    }
    if (typeof x.text !== "string") {
      throw new Error("An import has a " + x.kind + " message with no text.")
    }
    const date = Number.isNaN(Date.parse(x.date))
      ? undefined
      : new Date(x.date).toISOString()
    return {kind: x.kind, text: x.text, date, more: x.more === true}
  }

  // a summary built (Memory's made): counted, if the import's; sent to
  // each view shown its block (Views.teach)
  export function made(chat: Chat, l: number, i: number): void {
    if (chat.batch !== null) {
      Ingest.built(chat.batch, l, i - Math.floor(chat.batch.a / 2 ** l))
    }
    const [a] = Memory.span({l, i})
    for (const sock of chat.socks) {
      if (sock.data.seen.has(a + "+" + 2 ** l)) {
        Views.know(chat, sock, a, 2 ** l)
      }
    }
  }

  // as the view changes (Memory's wait): the state; done when all are
  // built; not as the chat is let go (Ingest.resumed)
  export function progress(chat: Chat): void {
    const batch = chat.batch
    if (batch === null || chat.mem.done) {
      return
    }
    if (batch.open.every((n) => n === 0)) {
      return Ingest.digest(chat, batch)
    }
    Ingest.keep(batch, chat)
    Views.all(chat, Views.state(chat))
  }

  export function digest(chat: Chat, batch: Batch): void {
    chat.batch = null
    fs.rmSync(chat.mem.dir + BATCH, {force: true})
    chat.eye = Views.eye(chat.mem, Math.max(chat.eye.from, batch.b))
    chat.socks.forEach((sock) => Views.show(chat, sock))
    const said = "Imported " + Import.import_count(batch.said, "") + "."
    Views.all(chat, {$: "note", text: said})
    Views.change(chat)
  }

  // an import paused, at once (Memory.pause), or resumed
  export function go(chat: Chat, on: boolean): Done {
    if (chat.batch === null) {
      return new Err(new Error("No import is running."))
    }
    if (on) {
      chat.mem.paused = false
    } else {
      Memory.pause(chat.mem)
    }
    Ingest.keep(chat.batch, chat)
    Views.all(chat, Views.state(chat))
    Memory.pump(chat.mem)
    Views.change(chat)
    return new Ok({})
  }
}
