// Prompt
// ======
// The input: a message typed (Enter sends it; Shift+Enter or Ctrl+J, a
// new line), a command (`/` lists them as typed, Tab or Enter takes
// one), the messages sent before (Up, Down at the input's first or last
// line), an image's path dropped or pasted (attached).

import type {KeyEvent, PasteEvent, TextareaRenderable} from "@opentui/core"
import {createMemo, createSignal, For, Show, type JSX} from "solid-js"
import * as fs from "node:fs"
import * as View from "../view/view.ts"
import {client_act, client_history, client_say, path_read} from "./client.ts"
import {cmd_image, cmd_match, cmd_run, cmd_word} from "./commands.ts"
import {useCtx} from "./ctx.ts"
import {THIN} from "./tool.tsx"

// Types
// =====

// what the app does with the input
export type PromptApi = {
  focus: () => void
  // whether the input has the keys; a key typed elsewhere, put in it
  has: () => boolean
  type: (text: string) => void
  set: (text: string) => void
  text: () => string
  clear: () => void
  // a key the input may take first (the list's moves); true: taken
  key: (e: KeyEvent) => boolean
}

// Constants
// =========

// the most commands listed at once
const LISTED = 8

// an image's file, by its name
const IMAGE = /\.(png|jpe?g|gif|webp)$/i

const KEYS = [
  {name: "return", action: "submit" as const},
  {name: "kpenter", action: "submit" as const},
  {name: "return", shift: true, action: "newline" as const},
  {name: "return", meta: true, action: "newline" as const},
  {name: "linefeed", action: "newline" as const}
]

// Prompt
// ======

export function Prompt(props: {
  api: (api: PromptApi) => void
  onSent: () => void
}): JSX.Element {
  const ctx = useCtx()
  const c = ctx.c
  const p = ctx.p
  let input: TextareaRenderable | undefined
  const [text, setText] = createSignal("")
  const [pick, setPick] = createSignal(0)
  // the history: where in it (its length: the input's own), what was
  // typed before going back
  let at = -1
  let draft = ""
  const typing = () => (c.rev(), View.view_typing(c.v))
  const matches = createMemo(() => (c.rev(), cmd_match(c, text())))
  const listed = createMemo(() => {
    const all = matches()
    const from = Math.max(0, Math.min(pick() - LISTED + 1, all.length - LISTED))
    return all
      .slice(from, from + LISTED)
      .map((cmd, k) => ({cmd, here: from + k === pick()}))
  })
  const hint = () =>
    typing()
      ? View.HINT + " · / for commands"
      : "Viewing " +
        (c.v.page?.name ?? "") +
        "'s chat · Tab goes back · commands only"

  function set(value: string): void {
    input?.setText(value)
    input?.gotoBufferEnd?.()
    setText(value)
  }

  // Enter: a command run, a message sent, or, empty, an interrupt
  function submit(): void {
    const value = input?.plainText ?? ""
    const list = matches()
    if (list.length > 0 && !list.some((k) => cmd_word(k) === value.trim())) {
      complete()
      return
    }
    if (value.trim().startsWith("/") && cmd_run(c, value)) {
      set("")
      at = -1
      props.onSent()
      return
    }
    if (!typing() && value.trim() !== "") {
      c.hooks.note("Messages go to Kazuki: Tab or /tab goes back.")
      return
    }
    if (value.trim() === "" && c.imgs().length === 0) {
      client_act(c, {$: "Send", text: ""})
      return
    }
    if (client_say(c, value)) {
      set("")
      at = -1
      props.onSent()
    }
  }

  // the command picked, in the input: run at once if it takes nothing
  function complete(): void {
    const cmd = matches()[pick()]
    if (cmd === undefined) {
      return
    }
    const word = cmd_word(cmd)
    if (cmd.use === word) {
      set("")
      cmd_run(c, word)
      props.onSent()
      return
    }
    set(word + " ")
  }

  // Up, Down: the history, at the input's first or last line; the list's
  // moves while it shows
  function key(e: KeyEvent): boolean {
    const list = matches()
    if (list.length > 0 && e.name === "escape") {
      set("")
      return true
    }
    if (list.length > 0 && (e.name === "up" || e.name === "down")) {
      setPick((pick() + (e.name === "up" ? -1 : 1) + list.length) % list.length)
      return true
    }
    if (list.length > 0 && e.name === "tab" && !e.shift) {
      complete()
      return true
    }
    if (
      input === undefined ||
      (e.name !== "up" && e.name !== "down") ||
      e.shift ||
      e.ctrl ||
      e.meta
    ) {
      return false
    }
    const row = input.logicalCursor.row
    const last = input.lineCount - 1
    if ((e.name === "up" && row !== 0) || (e.name === "down" && row !== last)) {
      return false
    }
    const sent = client_history(c)
    if (at < 0) {
      at = sent.length
      draft = input.plainText
    }
    const to = Math.max(
      0,
      Math.min(sent.length, at + (e.name === "up" ? -1 : 1))
    )
    if (to === at) {
      return false
    }
    at = to
    set(at === sent.length ? draft : sent[at])
    return true
  }

  // a path pasted or dropped: an image's attaches
  function paste(e: PasteEvent): void {
    const pasted = new TextDecoder().decode(e.bytes).trim()
    const file = path_read(pasted)
    if (IMAGE.test(file) && !pasted.includes("\n") && fs.existsSync(file)) {
      e.preventDefault()
      cmd_image(c, pasted).catch((err) =>
        c.hooks.note(String(err?.message ?? err))
      )
    }
  }

  props.api({
    focus: () => input?.focus(),
    has: () => input?.focused ?? false,
    type: (typed) => {
      input?.focus()
      input?.insertText(typed)
    },
    set,
    text: () => input?.plainText ?? "",
    clear: () => set(""),
    key
  })

  return (
    <box flexShrink={0}>
      {/* the list over the chat, right above the input, not in its flow */}
      <Show when={listed().length > 0}>
        <box
          position="absolute"
          top={-listed().length}
          left={0}
          right={0}
          zIndex={10}
          backgroundColor={p.raised}
          paddingLeft={1}
          paddingRight={1}
        >
          <For each={listed()}>
            {(row) => (
              <box
                flexDirection="row"
                gap={2}
                backgroundColor={row.here ? p.sunk : undefined}
              >
                <text
                  flexShrink={0}
                  fg={row.here ? p.accent : p.text}
                  width={18}
                >
                  {row.cmd.use}
                </text>
                <text flexGrow={1} fg={p.muted} wrapMode="word" maxHeight={1}>
                  {row.cmd.text}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={c.imgs().length > 0}>
        <box flexDirection="row" paddingLeft={2} gap={1} flexShrink={0}>
          <text fg={p.bg} bg={p.accent}>
            {" ▣ " +
              c.imgs().length +
              (c.imgs().length === 1 ? " image " : " images ")}
          </text>
          <text fg={p.faint}>goes with the next message</text>
        </box>
      </Show>
      <box
        border={["left"]}
        borderColor={typing() ? p.accent : p.border}
        customBorderChars={THIN}
        backgroundColor={p.raised}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        flexShrink={0}
      >
        <textarea
          ref={(r: TextareaRenderable) => (input = r)}
          focused={true}
          minHeight={1}
          maxHeight={10}
          placeholder={hint()}
          placeholderColor={p.faint}
          textColor={p.text}
          focusedTextColor={p.text}
          backgroundColor={p.raised}
          focusedBackgroundColor={p.raised}
          cursorColor={p.accent}
          wrapMode="word"
          keyBindings={KEYS}
          onContentChange={() => {
            setText(input?.plainText ?? "")
            setPick(0)
          }}
          onSubmit={() => setTimeout(submit, 0)}
          onPaste={paste}
        />
      </box>
    </box>
  )
}
