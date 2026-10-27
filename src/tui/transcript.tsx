// Transcript
// ==========
// The chat as it reads, top to bottom: View's rows as items (items.ts),
// then what streams. One chat, never a list of them: the memory tree
// shows as the agent sees it, older messages as summaries (a block,
// "8x", opened by a click into its two halves, as the agent zooms; one
// message opened whole, shut by another click), the turn on as whole
// messages: the user's
// framed by the accent bar, Kazuki's answer as markdown, its thinking
// faint and folded, each tool call a card (tool.tsx), an agent's report
// framed in its color.

import type {MouseEvent} from "@opentui/core"
import {useRenderer} from "@opentui/solid"
import {
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  type JSX
} from "solid-js"
import * as Call from "../view/call.ts"
import * as View from "../view/view.ts"
import {client_act, type Client} from "./client.ts"
import {useCtx} from "./ctx.ts"
import type {Block, Item, Then} from "./items.ts"
import {CallLine, click, THIN, ToolView} from "./tool.tsx"

// Items
// =====

export function Items(props: {items: Item[]}): JSX.Element {
  return <For each={props.items}>{(item) => <ItemView item={item} />}</For>
}

function ItemView(props: {item: Item}): JSX.Element {
  const it = props.item
  switch (it.$) {
    case "Cap":
      return <Cap text={it.text} />
    case "Sum":
      return (
        <Sum id={it.id} n={it.n} text={it.text} call={it.call} then={it.then} />
      )
    case "Box":
      return <Box id={it.id} n={it.n} items={it.items} />
    case "Opened":
      return <Opened blocks={it.blocks} item={it.item} />
    case "Tool":
      return <ToolView t={it} />
    case "Msg":
      return <Msg item={it} />
  }
}

// a message by its kind
export function Msg(props: {item: Item & {$: "Msg"}}): JSX.Element {
  const kind = () => props.item.kind
  return (
    <Switch fallback={<Answer text={props.item.text} live={props.item.live} />}>
      <Match when={kind() === "user"}>
        <User text={props.item.text} images={props.item.images.length} />
      </Match>
      <Match when={kind() === "mind"}>
        <Thinking text={props.item.text} live={props.item.live} />
      </Match>
      <Match when={kind() === "work"}>
        <Report text={props.item.text} />
      </Match>
      <Match when={kind() === "note"}>
        <Note text={props.item.text} />
      </Match>
      <Match when={kind() === "echo"}>
        <Echo text={props.item.text} />
      </Match>
    </Switch>
  )
}

// Messages
// ========

// the user's words, framed, as typed
function User(props: {text: string; images: number}): JSX.Element {
  const ctx = useCtx()
  const p = ctx.p
  return (
    <box
      border={["left"]}
      borderColor={p.accent}
      customBorderChars={THIN}
      backgroundColor={p.raised}
      paddingLeft={2}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      flexShrink={0}
    >
      <text fg={p.text} wrapMode="word">
        {props.text}
      </text>
      <Show when={props.images > 0}>
        <text fg={p.muted}>
          {`▣ ${props.images}${props.images === 1 ? " image" : " images"}`}
        </text>
      </Show>
    </box>
  )
}

// Kazuki's words, as markdown (streaming: its last block may change)
function Answer(props: {text: string; live: boolean}): JSX.Element {
  const ctx = useCtx()
  return (
    <box paddingLeft={2} paddingRight={1} flexShrink={0}>
      {/* its style before its content: a block parsed before has none */}
      <markdown
        syntaxStyle={ctx.syntax}
        fg={ctx.p.text}
        conceal={true}
        internalBlockMode="top-level"
        tableOptions={{style: "grid", cellPaddingX: 1}}
        content={props.text.trim()}
        streaming={props.live}
      />
    </box>
  )
}

// a thought: faint, its last lines while it streams, else its first;
// a click shows all of it
function Thinking(props: {text: string; live: boolean}): JSX.Element {
  const ctx = useCtx()
  const p = ctx.p
  const r = useRenderer()
  const [open, setOpen] = createSignal(false)
  const lines = createMemo(() =>
    props.text
      .trim()
      .split("\n")
      .filter((l) => l.trim() !== "")
  )
  const shown = createMemo(() =>
    open() ? lines() : props.live ? lines().slice(-3) : lines().slice(0, 1)
  )
  const more = () => lines().length - shown().length
  return (
    <box
      paddingLeft={2}
      paddingRight={1}
      flexShrink={0}
      onMouseUp={(e: MouseEvent) => click(e, () => setOpen(!open()), r)}
    >
      <box flexDirection="row" gap={1}>
        <text fg={p.faint} flexShrink={0}>
          {props.live ? ctx.spin() : "∴"}
        </text>
        <text fg={p.faint} flexShrink={0}>
          <i>{props.live ? "Thinking" : "Thought"}</i>
        </text>
        <Show when={more() > 0}>
          <text fg={p.faint}>
            {`· ${more()}${more() === 1 ? " more line" : " more lines"}`}
          </text>
        </Show>
      </box>
      <box paddingLeft={2}>
        <text fg={p.faint} wrapMode="word" maxHeight={open() ? undefined : 3}>
          <i>{shown().join("\n")}</i>
        </text>
      </box>
    </box>
  )
}

// an agent's report: its replies, framed in the agent's color, named
function Report(props: {text: string}): JSX.Element {
  const ctx = useCtx()
  const p = ctx.p
  const report = createMemo(
    () => Call.report_read(props.text) ?? {name: "Report", text: props.text}
  )
  return (
    <box
      border={["left"]}
      borderColor={p.agent}
      customBorderChars={THIN}
      backgroundColor={p.raised}
      paddingLeft={2}
      paddingRight={1}
      paddingBottom={1}
      flexShrink={0}
    >
      <text fg={p.agent}>
        <b>{`◆ ${report().name}`}</b>
        <span style={{fg: p.faint}}> reported</span>
      </text>
      <markdown
        syntaxStyle={ctx.syntax}
        fg={p.text}
        conceal={true}
        internalBlockMode="top-level"
        content={report().text.trim()}
      />
    </box>
  )
}

function Note(props: {text: string}): JSX.Element {
  const ctx = useCtx()
  return (
    <box paddingLeft={2} paddingRight={1} flexShrink={0}>
      <text fg={ctx.p.muted} wrapMode="word">
        <i>{props.text}</i>
      </text>
    </box>
  )
}

// a result without its call (its call was summarized away)
function Echo(props: {text: string}): JSX.Element {
  const ctx = useCtx()
  return (
    <box
      backgroundColor={ctx.p.raised}
      paddingLeft={2}
      paddingRight={1}
      flexShrink={0}
    >
      <text fg={ctx.p.muted} wrapMode="char" maxHeight={8}>
        {props.text}
      </text>
    </box>
  )
}

// a line about the page: the AI notice, an agent's page's head
function Cap(props: {text: string}): JSX.Element {
  const ctx = useCtx()
  return (
    <box paddingLeft={2} flexShrink={0}>
      <text fg={ctx.p.faint}>{props.text}</text>
    </box>
  )
}

// Blocks
// ======

// blocks shut: what they hold back to its summary
function shut(c: Client, blocks: Block[]): void {
  blocks.forEach(([id, n]) => client_act(c, {$: "Shut", id, n}))
}

// a summary of n messages from id: a click opens it (asks for its two
// halves, or the message whole); a call's, its result's after it, both
// opened at once
function Sum(props: {
  id: number
  n: number
  text: string
  call: Call.Call | null
  then: Then | null
}): JSX.Element {
  const ctx = useCtx()
  const p = ctx.p
  const r = useRenderer()
  const [hover, setHover] = createSignal(false)
  const open = () => {
    client_act(ctx.c, {$: "Open", id: props.id, n: props.n})
    if (props.then !== null) {
      client_act(ctx.c, {$: "Open", id: props.then.id, n: 1})
    }
  }
  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={2}
      paddingRight={1}
      flexShrink={0}
      backgroundColor={hover() ? p.raised : undefined}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(e: MouseEvent) => click(e, open, r)}
    >
      <text flexShrink={0} fg={p.faint}>
        {`▸ ${size_show(props.n)}`.trimEnd()}
      </text>
      <Show
        when={props.call}
        fallback={
          <text
            flexGrow={1}
            fg={hover() ? p.text : p.muted}
            wrapMode="word"
            maxHeight={2}
          >
            {props.text}
          </text>
        }
      >
        {(call) => (
          <box flexGrow={1}>
            <CallLine call={call()} />
            <Show when={props.then}>
              {(then) => (
                <text fg={p.faint} wrapMode="word" maxHeight={1}>
                  {`↳ ${then().text.replace(/^echo: /, "")}`}
                </text>
              )}
            </Show>
          </box>
        )}
      </Show>
      <text flexShrink={0} fg={p.faint}>
        {View.block_name(props.id, props.n)}
      </text>
    </box>
  )
}

// a summary opened: its head (a click folds it), its halves under a bar;
// one message opened is the message, no bar
function Box(props: {id: number; n: number; items: Item[]}): JSX.Element {
  const ctx = useCtx()
  const p = ctx.p
  const r = useRenderer()
  const [hover, setHover] = createSignal(false)
  return (
    <Show when={props.n > 1} fallback={<Items items={props.items} />}>
      <box flexShrink={0} gap={1}>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={2}
          paddingRight={1}
          flexShrink={0}
          backgroundColor={hover() ? p.raised : undefined}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={(e: MouseEvent) =>
            click(e, () => shut(ctx.c, [[props.id, props.n]]), r)
          }
        >
          <text fg={hover() ? p.text : p.faint}>
            {`▾ ${size_show(props.n)}`}
          </text>
          <text fg={p.faint} flexGrow={1}>
            {"messages " +
              props.id +
              "–" +
              (props.id + props.n - 1) +
              " · click to fold"}
          </text>
          <text fg={p.faint}>{View.block_name(props.id, props.n)}</text>
        </box>
        <box
          border={["left"]}
          borderColor={hover() ? p.accent : p.border}
          customBorderChars={THIN}
          marginLeft={2}
          gap={1}
          flexShrink={0}
        >
          <Items items={props.items} />
        </box>
      </box>
    </Show>
  )
}

// a message opened by hand: as it reads whole, highlighted under the
// pointer; a click shuts it back to its summary
function Opened(props: {blocks: Block[]; item: Item}): JSX.Element {
  const ctx = useCtx()
  const p = ctx.p
  const r = useRenderer()
  const [hover, setHover] = createSignal(false)
  const close = () => shut(ctx.c, props.blocks)
  return (
    <Show
      when={props.item.$ !== "Tool"}
      fallback={<ToolView t={props.item as Item & {$: "Tool"}} shut={close} />}
    >
      <box
        flexShrink={0}
        backgroundColor={hover() ? p.raised : undefined}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={(e: MouseEvent) => click(e, close, r)}
      >
        <ItemView item={props.item} />
      </box>
    </Show>
  )
}

// how many messages a block holds, as it shows: "8x" (one: none)
function size_show(n: number): string {
  return n === 1 ? "" : `${n}x`
}
