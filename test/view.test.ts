// View test
// =========
// `bun test view.test.ts`. What a view draws of the server's messages.

import { expect, test } from "bun:test";
import * as View from "../src/view/view.ts";

const tail = (v: View.View) => View.view_tail(v).map((row) => (row.$ === "Cap" ? row.text : row.$));

// a turn waiting on its model names the model the server says: the
// wait holds it, so no pick (none yet) can name none
test("a turn's wait names its model", () => {
  const v = View.view_new();
  View.view_hear(v, { $: "state", ...v, wait: "claude-opus-5-5", pick: null });
  expect(tail(v)).toEqual(["waiting for claude-opus-5-5…"]);
  View.view_hear(v, { $: "state", ...v, wait: View.SUMMARIES });
  expect(tail(v)).toEqual(["compressing earlier messages…"]);
  View.view_hear(v, { $: "state", ...v, wait: "" });
  expect(tail(v)).toEqual([]);
});

// a model with no effort or speed shows no knob for it, and a move to
// one is told, not sent
test("a model with no effort has no effort knob, and a move to it is a note", () => {
  const v = View.view_new();
  const rate = { input: 1, write: 0, read: 0, output: 2 };
  View.view_hear(v, { $: "state", ...v, providers: [{ id: "c", name: "C", models: [{ label: "plain", id: "p", name: "P", rate }] }], pick: { vendor: "c", model: "plain" } });
  expect(View.view_pick(v).map((k) => k.move)).toEqual(["model"]);
  expect(View.view_act(v, { $: "Move", move: "up" })).toEqual([]);
  expect(View.view_act(v, { $: "Move", move: "speed" })).toEqual([]);
  expect(v.notes).toEqual(["plain does not support effort.", "plain does not support speed."]);
});

// a move before the chat's pick came is told, not dropped
test("a move before the chat loaded is a note", () => {
  const v = View.view_new();
  expect(View.view_act(v, { $: "Move", move: "model" })).toEqual([]);
  expect(v.notes).toEqual(["The chat has not loaded yet."]);
});
