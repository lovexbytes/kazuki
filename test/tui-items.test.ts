import {expect, test} from "bun:test"
import type {Kind} from "../src/ai/ask-ai.ts"
import * as Call from "../src/view/call.ts"
import type * as View from "../src/view/view.ts"
import {items_of, tool_of} from "../src/tui/items.ts"

function msg(id: number | null, kind: Kind, text: string): View.Row {
  return {$: "Msg", id, kind, who: "", text, body: [], call: null, images: []}
}

function sum(
  id: number,
  n: number,
  text: string,
  call: Call.Call | null = null
): View.Row {
  return {$: "Sum", id, n, text, call}
}

test("a call and its result join as one tool, made once", () => {
  const rows = [
    msg(1, "tool", 'shell {"command":"ls"}'),
    msg(2, "echo", "a\nb")
  ]
  const [t] = items_of(rows)
  expect(t).toMatchObject({
    $: "Tool",
    id: 1,
    result: "a\nb",
    fail: false,
    live: false,
    stopped: false
  })
  expect(t.$ === "Tool" && t.call.name).toBe("shell")
  expect(items_of(rows)[0]).toBe(t)
})

test("a result that failed says so, without its prefix", () => {
  const [t] = items_of([
    msg(1, "tool", 'read {"path":"x"}'),
    msg(2, "echo", "error: no such file")
  ])
  expect(t).toMatchObject({$: "Tool", fail: true, result: "no such file"})
})

test("a call logged without a result was stopped; one streaming is its name alone", () => {
  expect(items_of([msg(3, "tool", 'shell {"comm')])[0]).toMatchObject({
    $: "Tool",
    input: null,
    stopped: true
  })
  const live = tool_of(null, "mcp__x__shell", null, true)
  expect(live.call.name).toBe("shell")
  expect(live.stopped).toBe(false)
})

test("a call's summary and its result's, next to it, join as one summary", () => {
  const call = Call.call_parse('shell {"command":"ls"}')
  const items = items_of([sum(4, 1, "shell ls", call), sum(5, 1, "two files")])
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    $: "Sum",
    id: 4,
    next: {id: 5, text: "two files"}
  })
})

test("a call and its result opened by hand shut together; opened by default, not wrapped", () => {
  const box = (id: number, row: View.Row): View.Row => ({
    $: "Box",
    id,
    n: 1,
    text: "fold",
    rows: [row]
  })
  const rows = [
    box(1, msg(1, "tool", 'shell {"command":"ls"}')),
    box(2, msg(2, "echo", "ok"))
  ]
  const [hand] = items_of(rows, () => true)
  expect(hand).toMatchObject({
    $: "Opened",
    blocks: [
      [1, 1],
      [2, 1]
    ],
    item: {$: "Tool", result: "ok"}
  })
  expect(items_of(rows, () => false)[0]).toMatchObject({
    $: "Tool",
    result: "ok"
  })
})

test("a thought made anew keeps its item, so a redraw keeps it", () => {
  const a = items_of([msg(null, "mind", "thinking it over")])[0]
  const b = items_of([msg(null, "mind", "thinking it over")])[0]
  expect(b).toBe(a)
})

test("a call stopped does not take the next message's summary as its result", () => {
  const call = Call.call_parse('shell {"command":"ls"}')
  const items = items_of([
    sum(4, 1, "shell ls", call),
    sum(5, 1, "user: stop, do X instead")
  ])
  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({$: "Sum", id: 4, next: null})
})

test("a call opened, then its result too, is wrapped anew to shut both", () => {
  const box = (id: number, row: View.Row): View.Row => ({
    $: "Box",
    id,
    n: 1,
    text: "fold",
    rows: [row]
  })
  const rows = [
    box(1, msg(1, "tool", 'shell {"command":"pwd"}')),
    box(2, msg(2, "echo", "/"))
  ]
  expect(items_of(rows, (id) => id === 1)[0]).toMatchObject({
    $: "Opened",
    blocks: [[1, 1]]
  })
  expect(items_of(rows, () => true)[0]).toMatchObject({
    $: "Opened",
    blocks: [
      [1, 1],
      [2, 1]
    ]
  })
})
