// Items
// =====
// What the transcript draws, from View's rows (View.view_body): a tool
// call and the result logged right after it (server.ts logs a call with
// its result) join as one Tool, its result null while it runs; the rest
// as they are. Each item is made once for the rows it holds, so a
// redraw remakes only what changed (View's rows are made once too).

import * as Call from "../view/call.ts"
import type {Kind} from "../ai/ask-ai.ts"
import type {Live} from "../ai/live.ts"
import {WHO} from "../view/theme.ts"
import type * as View from "../view/view.ts"

// Types
// =====

type Msg = View.Row & {$: "Msg"}
type Sum = View.Row & {$: "Sum"}

// a call's summary's result, summarized after it: its message, its line
export type Then = {id: number; text: string}

// a message opened by hand: its block, shut by a click
export type Block = [id: number, n: number]

// a tool call: its call as call.ts reads it, its input (null: not JSON
// yet, while it streams), its result's text (null: none yet), whether
// that failed; live: still streaming or waiting; stopped: logged with
// no result (the turn was stopped)
export type Tool = {
  $: "Tool"
  id: number | null
  call: Call.Call
  input: Record<string, unknown> | null
  result: string | null
  fail: boolean
  live: boolean
  stopped: boolean
}

export type Item =
  | {$: "Cap"; text: string}
  | {
      $: "Sum"
      id: number
      n: number
      text: string
      call: Call.Call | null
      next: Then | null
    }
  | {$: "Box"; id: number; n: number; items: Item[]}
  | {$: "Opened"; blocks: Block[]; item: Item}
  | {
      $: "Msg"
      id: number | null
      kind: Kind
      who: string
      text: string
      images: string[]
      live: boolean
    }
  | Tool

// Constants
// =========

const CALL = /^(\S+) (\{[\s\S]*)$/

// a line of one message kept word for word, by another than a result:
// no call's result (a call stopped has none; the next message is not it)
const OTHER = /^(user|kazuki|note|work|mind|tool): /
const FAIL = "error: "
const MCP = /^mcp__.+?__/

// Items
// =====

const MADE = new WeakMap<object, Item>()
const PAIRS = new WeakMap<object, WeakMap<object, Item>>()
const BOXES = new Map<string, Item>()

// the rows given, as items; a message opened (a box of one) is its
// rows, so a call and its result opened pair as they would whole; one
// opened by hand (opened says) is wrapped, to be shut by a click
export function items_of(
  given: View.Row[],
  opened?: (id: number, n: number) => boolean
): Item[] {
  const rows: View.Row[] = []
  const from: (number | null)[] = []
  for (const r of given) {
    if (r.$ === "Box" && r.n === 1) {
      const mine = opened?.(r.id, 1) ? r.id : null
      rows.push(...r.rows)
      from.push(...r.rows.map(() => mine))
    } else {
      rows.push(r)
      from.push(null)
    }
  }
  const out: Item[] = []
  for (let k = 0; k < rows.length; k += 1) {
    const row = rows[k]
    const next = rows[k + 1]
    const both =
      (row.$ === "Msg" &&
        row.kind === "tool" &&
        next?.$ === "Msg" &&
        next.kind === "echo") ||
      (row.$ === "Sum" &&
        row.call !== null &&
        next?.$ === "Sum" &&
        next.n === 1 &&
        next.call === null &&
        next.id === row.id + 1 &&
        !OTHER.test(next.text))
    const made = both
      ? pair(row as Msg | Sum, next as Msg | Sum)
      : item(row, opened)
    const ids = [
      ...new Set(
        (both ? [from[k], from[k + 1]] : [from[k]]).filter((x) => x !== null)
      )
    ]
    out.push(ids.length === 0 ? made : opened_of(made, ids))
    k += both ? 1 : 0
  }
  return out
}

// an item opened by hand, wrapped once for the blocks opened (a call
// opened, then its result too, is wrapped anew: a click shuts both)
const OPENED = new WeakMap<Item, Map<string, Item>>()

function opened_of(made: Item, ids: number[]): Item {
  const key = ids.join(",")
  const known = OPENED.get(made)?.get(key)
  if (known !== undefined) {
    return known
  }
  const out: Item = {
    $: "Opened",
    blocks: ids.map((id): Block => [id, 1]),
    item: made
  }
  OPENED.set(made, (OPENED.get(made) ?? new Map()).set(key, out))
  return out
}

// what streams, as items: a call without its result runs
export function items_live(live: Live[]): Item[] {
  return live.flatMap((l): Item[] => {
    if (l.kind === "tool") {
      return [tool_of(null, l.text, null, true)]
    }
    if (l.text.trim() === "") {
      return []
    }
    return [
      {
        $: "Msg",
        id: null,
        kind: l.kind,
        who: WHO[l.kind] ?? "",
        text: l.text,
        images: [],
        live: true
      }
    ]
  })
}

// rows View makes anew at each view (a thought, a cap): their items by
// what they say, so a redraw keeps them (a thought opened stays open)
const SAID = new Map<string, Item>()
const SAID_MOST = 2000

function item(
  row: View.Row,
  opened?: (id: number, n: number) => boolean
): Item {
  const made = MADE.get(row)
  if (made !== undefined && row.$ !== "Box") {
    return made
  }
  const key =
    row.$ === "Cap"
      ? `cap\0${row.text}`
      : row.$ === "Msg" && row.id === null
        ? `${row.kind}\0${row.text}`
        : null
  const known = key === null ? undefined : SAID.get(key)
  const out = known ?? item_make(row, opened)
  if (key !== null && known === undefined) {
    if (SAID.size >= SAID_MOST) {
      SAID.clear()
    }
    SAID.set(key, out)
  }
  MADE.set(row, out)
  return out
}

function item_make(
  row: View.Row,
  opened?: (id: number, n: number) => boolean
): Item {
  switch (row.$) {
    case "Cap": {
      // made anew at each view: a line, cheap to draw again
      return {$: "Cap", text: row.text}
    }
    case "Sum": {
      return {
        $: "Sum",
        id: row.id,
        n: row.n,
        text: row.text,
        call: row.call,
        next: null
      }
    }
    case "Box": {
      // a box is drawn anew at each view: the same box holding the same
      // items is the one made before
      const items = items_of(row.rows, opened)
      const key = `${row.id}+${row.n}`
      const was = BOXES.get(key)
      if (
        was?.$ === "Box" &&
        was.items.length === items.length &&
        was.items.every((x, k) => x === items[k])
      ) {
        return was
      }
      const box: Item = {$: "Box", id: row.id, n: row.n, items}
      BOXES.set(key, box)
      return box
    }
    case "Msg": {
      if (row.kind === "tool") {
        return tool_of(row.id, row.text, null, false)
      }
      return {
        $: "Msg",
        id: row.id,
        kind: row.kind,
        who: row.who,
        text: row.text,
        images: row.images,
        live: false
      }
    }
  }
}

// a call and its result: whole, a tool; summarized, a summary of both
function pair(call: Msg | Sum, echo: Msg | Sum): Item {
  const known = PAIRS.get(call)?.get(echo)
  if (known !== undefined) {
    return known
  }
  const out: Item =
    call.$ === "Sum"
      ? {
          $: "Sum",
          id: call.id,
          n: 1,
          text: call.text,
          call: call.call,
          next: {id: echo.id ?? call.id + 1, text: echo.text}
        }
      : tool_of(call.id, call.text, echo.text, false)
  const map = PAIRS.get(call) ?? new WeakMap()
  map.set(echo, out)
  PAIRS.set(call, map)
  return out
}

// a tool call logged as `name {json}`, and its result
export function tool_of(
  id: number | null,
  text: string,
  result: string | null,
  live: boolean
): Tool {
  // a call streaming is its name alone till its input starts; one cut
  // short (stopped) may be no JSON call.ts reads: its name, still
  const named = Call.call_parse(text)
  const word = /^(\S+)(?: |$)/.exec(text)?.[1] ?? ""
  const bare =
    named.name === "" &&
    word !== "" &&
    (live || text.slice(word.length + 1).startsWith("{"))
  const call = bare ? {...named, name: word.replace(MCP, ""), head: ""} : named
  const m = CALL.exec(text)
  const input = m === null ? null : json_object(m[2])
  const fail = result?.startsWith(FAIL) ?? false
  const out = result === null ? null : fail ? result.slice(FAIL.length) : result
  return {
    $: "Tool",
    id,
    call,
    input,
    result: out,
    fail,
    live,
    stopped: !live && result === null
  }
}

function json_object(text: string): Record<string, unknown> | null {
  try {
    const x = JSON.parse(text)
    return typeof x === "object" && x !== null && !Array.isArray(x) ? x : null
  } catch {
    return null
  }
}

// a string field of a tool's input ("": none)
export function input_text(t: Tool, key: string): string {
  const x = t.input?.[key]
  return typeof x === "string" ? x : ""
}
