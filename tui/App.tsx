// App
// ===
// The terminal's chat, one page: the transcript (Transcript.tsx), what
// is at work (a status line: the turn, its wait, the agents, the jobs
// run here, an import), the input (Prompt.tsx), and a footer (the tabs,
// the pick, the link). Notes come as toasts; /help, /account and an
// import's plan as a sheet over the page; a pick as a list.

import type { KeyEvent, ScrollBoxRenderable, Selection } from "@opentui/core";
import { useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import * as View from "../View.ts";
import { Pick, type Move } from "../Pick.ts";
import { client_act, type Client } from "./Client.ts";
import { cmd_cycle, cmd_fold, pick_options } from "./Commands.ts";
import { CtxOf, SPIN, useCtx, type Ctx } from "./Ctx.ts";
import { items_live, items_of, type Item, type Tool } from "./Items.ts";
import { syntax_of, type Palette } from "./Palette.ts";
import { Prompt, type PromptApi } from "./Prompt.tsx";
import { Items, Msg } from "./Transcript.tsx";
import { THIN, ToolView } from "./Tool.tsx";

// Types
// =====

type Toast  = { id: number; text: string };
type Sheet  = { title: string; md: string };
type Picker = { move: "model" | "effort" | "speed" };

// Constants
// =========

// how long a toast shows (ms), and how many at once
const TOAST = 5000;
const TOASTS = 3;

// the pick's moves by Shift and an arrow
const ARROWS: Record<string, Move> = { left: "prev", right: "next", up: "up", down: "down" };

// App
// ===

export function App(props: { c: Client; p: Palette; quit: () => void }): JSX.Element {
  const c   = props.c;
  const p   = props.p;
  const r   = useRenderer();
  const dim = useTerminalDimensions();
  const syntax  = syntax_of(p, r.nativeScene);
  const [frame, setFrame]     = createSignal(0);
  const [outputs, setOutputs] = createSignal(false);
  const [toasts, setToasts]   = createSignal<Toast[]>([]);
  const [sheet, setSheet]     = createSignal<Sheet | null>(null);
  const [picker, setPicker]   = createSignal<Picker | null>(null);
  let prompt: PromptApi | undefined;
  let scroll: ScrollBoxRenderable | undefined;
  let toastId = 0;

  const ctx: Ctx = {
    c,
    p,
    syntax,
    spin    : () => SPIN[frame() % SPIN.length],
    outputs,
    width   : () => dim().width,
  };

  // the spinner turns while anything runs
  const timer = setInterval(() => {
    if (View.view_running(c.v) || c.jobs.size > 0 || c.v.live.length > 0) {
      setFrame((n) => n + 1);
    }
  }, 80);
  onCleanup(() => clearInterval(timer));

  c.hooks.note = (text) => {
    const id = ++toastId;
    setToasts((ts) => [...ts, { id, text }].slice(-TOASTS));
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TOAST);
  };
  c.hooks.sheet = (title, md) => setSheet({ title, md });
  c.hooks.back  = (sent) => {
    if (prompt !== undefined && prompt.text() === "" && c.imgs().length === 0) {
      prompt.set(sent.text);
      c.setImgs(sent.images ?? []);
    }
  };
  c.hooks.pick  = (move) => setPicker({ move });
  c.hooks.quit  = props.quit;

  // the chat's items (made again only as its rows change), then what
  // streams
  const items = createMemo<Item[]>(() => (c.log(), items_of(View.view_body(c.v), (id, n) => c.v.open.get(id + "+" + n) === true)));
  const live  = createMemo<Item[]>(() => (c.rev(), items_live(View.view_stream(c.v))));
  const unsent = createMemo(() => (c.rev(), c.v.page === null && !c.v.up ? c.v.out.map((x) => x.said).filter((s) => s !== "") : []));

  // the input has the keys again once a sheet or a list closes
  createEffect(on([sheet, picker], ([s, k]) => s === null && k === null && prompt?.focus(), { defer: true }));

  // unfolded: back to the chat's bottom
  createEffect(on(() => (c.rev(), c.v.fold === null), (whole, was) => {
    if (whole && was === false) {
      setTimeout(() => scroll?.scrollTo(scroll.scrollHeight), 0);
    }
  }));

  // a selection's text is copied (OSC 52: also over ssh)
  useSelectionHandler((sel: Selection) => {
    const text = sel.getSelectedText();
    if (text !== "" && !sel.isDragging) {
      r.copyToClipboardOSC52(text);
      c.hooks.note("Copied " + text.length + (text.length === 1 ? " character." : " characters."));
    }
  });

  useKeyboard((e: KeyEvent) => {
    if (sheet() !== null || picker() !== null) {
      if (e.name === "escape" || (e.name === "c" && e.ctrl) || (e.name === "return" && sheet() !== null)) {
        setSheet(null);
        setPicker(null);
        e.preventDefault();
      } else if (sheet() !== null && (e.name === "up" || e.name === "down" || e.name === "pageup" || e.name === "pagedown")) {
        sheetScroll?.scrollBy(e.name === "up" ? -1 : e.name === "down" ? 1 : e.name === "pageup" ? -0.5 : 0.5, e.name.startsWith("page") ? "viewport" : "absolute");
        e.preventDefault();
      } else if (sheet() !== null) {
        // the input under a sheet takes nothing
        e.preventDefault();
      }
      return;
    }
    if (key(e)) {
      e.preventDefault();
    }
  });

  // a key the page takes; false: the input's
  function key(e: KeyEvent): boolean {
    // a character typed while the input lost the keys goes to it
    if (prompt !== undefined && !prompt.has() && !e.ctrl && !e.meta && [...e.sequence].length === 1 && e.sequence >= " " && e.sequence !== "\x7f") {
      prompt.type(e.sequence);
      return true;
    }
    if (prompt?.key(e)) {
      return true;
    }
    if (e.shift && ARROWS[e.name] !== undefined) {
      client_act(c, { $: "Move", move: ARROWS[e.name] });
      return true;
    }
    if (e.name === "tab" && e.shift) {
      client_act(c, { $: "Move", move: "speed" });
      return true;
    }
    if (e.name === "tab") {
      cmd_cycle(c);
      return true;
    }
    if (e.name === "escape") {
      if (c.v.busy) {
        client_act(c, { $: "Send", text: "" });
      }
      return true;
    }
    if (e.ctrl && e.name === "c") {
      if (prompt !== undefined && prompt.text() !== "") {
        prompt.clear();
      } else if (c.imgs().length > 0) {
        c.setImgs([]);
        c.hooks.note("Images dropped.");
      } else if (c.v.busy) {
        client_act(c, { $: "Send", text: "" });
      } else {
        c.hooks.note("Ctrl+D or /quit leaves; the chat goes on without this terminal.");
      }
      return true;
    }
    if (e.ctrl && e.name === "d") {
      if (prompt?.text() === "") {
        props.quit();
      } else {
        prompt?.clear();
      }
      return true;
    }
    if (e.ctrl && e.name === "o") {
      setOutputs(!outputs());
      return true;
    }
    if (e.ctrl && e.name === "f") {
      cmd_fold(c);
      return true;
    }
    if (e.ctrl && e.name === "p") {
      if (c.v.pick !== null) {
        setPicker({ move: "model" });
      }
      return true;
    }
    if (e.ctrl && e.name === "z") {
      suspend();
      return true;
    }
    if (e.name === "pageup" || e.name === "pagedown") {
      scroll?.scrollBy(e.name === "pageup" ? -0.5 : 0.5, "viewport");
      return true;
    }
    if (e.name === "end" && e.ctrl) {
      scroll?.scrollTo(scroll.scrollHeight);
      return true;
    }
    return false;
  }

  // Ctrl+Z: the terminal back to the shell till fg
  async function suspend(): Promise<void> {
    await r.suspend();
    process.once("SIGCONT", () => {
      r.resume();
    });
    process.kill(process.pid, "SIGTSTP");
  }

  let sheetScroll: ScrollBoxRenderable | undefined;

  return (
    <CtxOf.Provider value={ctx}>
      <box width="100%" height="100%" backgroundColor={p.bg} flexDirection="column">
        <scrollbox
          ref={(s: ScrollBoxRenderable) => (scroll = s)}
          flexGrow={1}
          stickyScroll={true}
          stickyStart="bottom"
          viewportCulling={true}
          verticalScrollbarOptions={{ trackOptions: { backgroundColor: p.bg, foregroundColor: p.border } }}
        >
          <box gap={1} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
            <Show when={!c.v.up && items().length === 0}>
              <Connecting />
            </Show>
            <Items items={items()} />
            <Index each={live()}>
              {(item) => <LiveItem item={item()} />}
            </Index>
            <For each={unsent()}>
              {(text) => <Msg item={{ $: "Msg", id: null, kind: "user", who: "", text, images: [], live: false }} />}
            </For>
            <Show when={unsent().length > 0}>
              <box paddingLeft={2}><text fg={p.faint}>Sends once connected.</text></box>
            </Show>
          </box>
        </scrollbox>
        <Status />
        {/* over the status line: the input's command list shows above it */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0} zIndex={5}>
          <Prompt api={(api) => (prompt = api)} onSent={() => scroll?.scrollTo(scroll.scrollHeight)} />
        </box>
        <Footer openPick={(move) => setPicker({ move })} />
        <Toasts toasts={toasts()} />
        <Show when={sheet()}>
          {(s) => <SheetView sheet={s()} scrollRef={(x) => (sheetScroll = x)} close={() => setSheet(null)} />}
        </Show>
        <Show when={picker()}>
          {(k) => <PickerView move={k().move} close={() => setPicker(null)} />}
        </Show>
      </box>
    </CtxOf.Provider>
  );
}

// a live item: its message or call as it streams
function LiveItem(props: { item: Item }): JSX.Element {
  return (
    <Switch>
      <Match when={props.item.$ === "Tool"}><ToolView t={props.item as Tool} /></Match>
      <Match when={props.item.$ === "Msg"}><Msg item={props.item as Item & { $: "Msg" }} /></Match>
    </Switch>
  );
}

function Connecting(): JSX.Element {
  const ctx = useCtx();
  return (
    <box paddingLeft={2}>
      <text fg={ctx.p.muted}>{ctx.spin() + " Connecting to " + ctx.c.url + "…"}</text>
    </box>
  );
}

// Status
// ======

// what is at work, on a line over the input: the turn (its wait, its
// time), the agents, the jobs run here, an import; offline, that
function Status(): JSX.Element {
  const ctx = useCtx();
  const c   = ctx.c;
  const p   = ctx.p;
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => c.since > 0 && setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const busy  = () => (c.rev(), c.v.busy);
  const wait  = () => {
    c.rev();
    if (c.v.wait === View.SUMMARIES) {
      return "compressing earlier messages";
    }
    if (c.v.wait !== "") {
      return "waiting for " + c.v.wait;
    }
    return c.v.live.length > 0 ? "working" : "thinking";
  };
  // the clock as last read, else the turn's start: never before it
  const time   = () => (c.rev(), c.since === 0 ? "" : secs_show(Math.max(0, now() - c.since) / 1000));
  const agents = () => (c.rev(), c.v.agents);
  const jobs   = () => (c.rev(), c.jobs.size);
  const load   = () => (c.rev(), c.v.importing === null ? "" : View.progress_show(c.v, c.v.importing));
  const up     = () => (c.rev(), c.v.up);
  const shown  = () => busy() || agents().length > 0 || jobs() > 0 || load() !== "" || !up();
  return (
    <Show when={shown()}>
      <box flexDirection="row" gap={2} paddingLeft={3} paddingRight={2} flexShrink={0} height={1}>
        <Show when={!up()}>
          <text fg={p.warn} flexShrink={0}>{"○ offline · reconnecting"}</text>
        </Show>
        <Show when={busy()}>
          <text fg={p.accent} flexShrink={0}>
            {ctx.spin() + " "}
            <span style={{ fg: p.text }}>{wait()}</span>
            <span style={{ fg: p.faint }}>{(time() === "" ? "" : " · " + time()) + " · esc to interrupt"}</span>
          </text>
        </Show>
        <Show when={agents().length > 0}>
          <text fg={p.agent} flexShrink={1} wrapMode="none">{"◆ " + agents().join(", ") + " at work"}</text>
        </Show>
        <Show when={jobs() > 0}>
          <text fg={p.warn} flexShrink={0}>{"⚙ " + jobs() + (jobs() === 1 ? " job" : " jobs") + " here"}</text>
        </Show>
        <Show when={load() !== ""}>
          <text fg={p.muted} flexShrink={1} wrapMode="none">{"⇣ " + load()}</text>
        </Show>
      </box>
    </Show>
  );
}

// Footer
// ======

// the tabs on the left; the pick, the credit and the server on the right
function Footer(props: { openPick: (move: "model" | "effort" | "speed") => void }): JSX.Element {
  const ctx   = useCtx();
  const c     = ctx.c;
  const p     = ctx.p;
  const tabs  = () => (c.rev(), View.view_tabs(c.v));
  const knobs = () => (c.rev(), View.view_pick(c.v));
  const cred  = () => (c.rev(), View.view_credits(c.v));
  const host  = c.url.replace(/^https?:\/\//, "");
  return (
    <box flexDirection="row" paddingLeft={3} paddingRight={2} flexShrink={0} height={1} gap={2}>
      <box flexDirection="row" gap={2} flexGrow={1} flexShrink={1} overflow="hidden">
        <For each={tabs()}>
          {(tab) => (
            <text
              flexShrink={0}
              fg={tab.here ? (tab.name === null ? p.accent : p.agent) : p.faint}
              onMouseUp={() => client_act(c, { $: "Goto", name: tab.name })}
            >
              {(tab.here ? "● " : "○ ") + (tab.name ?? View.MAIN)}
            </text>
          )}
        </For>
      </box>
      <For each={knobs()}>
        {(k) => (
          <text flexShrink={0} fg={k.move === "model" ? p.text : p.muted} onMouseUp={() => props.openPick(k.move as "model" | "effort" | "speed")}>
            {k.text}
          </text>
        )}
      </For>
      <Show when={cred()}>
        <text flexShrink={0} fg={p.muted}>{cred()}</text>
      </Show>
      <text flexShrink={0} fg={p.faint}>{host}</text>
    </box>
  );
}

// Toasts
// ======

function Toasts(props: { toasts: Toast[] }): JSX.Element {
  const ctx = useCtx();
  const p   = ctx.p;
  return (
    <box position="absolute" top={1} right={2} width={Math.min(60, Math.max(30, Math.floor(ctx.width() * 0.4)))} gap={1} zIndex={10}>
      <For each={props.toasts}>
        {(t) => (
          <box border={["left"]} borderColor={p.accent} customBorderChars={THIN} backgroundColor={p.sunk} paddingLeft={1} paddingRight={1}>
            <text fg={p.text} wrapMode="word">{t.text}</text>
          </box>
        )}
      </For>
    </box>
  );
}

// Sheet
// =====

// a page of markdown over the chat: Esc or Enter closes it
function SheetView(props: { sheet: Sheet; close: () => void; scrollRef: (s: ScrollBoxRenderable) => void }): JSX.Element {
  const ctx = useCtx();
  const p   = ctx.p;
  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={20} alignItems="center" justifyContent="center" backgroundColor={p.bg}>
      <box width={Math.min(110, ctx.width() - 4)} height="90%" border={true} borderStyle="rounded" borderColor={p.border} backgroundColor={p.raised} paddingLeft={2} paddingRight={2} paddingTop={1} title={" " + props.sheet.title + " "} titleAlignment="left" bottomTitle=" esc to close · ↑↓ to scroll " bottomTitleAlignment="right">
        <scrollbox ref={props.scrollRef} flexGrow={1} flexShrink={1} minHeight={0}>
          <markdown syntaxStyle={ctx.syntax} fg={p.text} conceal={true} tableOptions={{ style: "columns", wrapMode: "word", widthMode: "full" }} content={props.sheet.md} />
        </scrollbox>
      </box>
    </box>
  );
}

// Picker
// ======

// the values a part of the pick may take, the one now marked: Enter
// takes one, Esc keeps the pick
function PickerView(props: { move: "model" | "effort" | "speed"; close: () => void }): JSX.Element {
  const ctx  = useCtx();
  const c    = ctx.c;
  const p    = ctx.p;
  const opts = createMemo(() => (c.rev(), pick_options(c, props.move)));
  const now  = () => Math.max(0, opts().findIndex((o) => o.now));
  const title = { model: "Model", effort: "Effort", speed: "Speed" }[props.move];
  const hint  = () => (c.v.pick === null ? "" : Pick.label(c.v.pick));
  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={20} alignItems="center" justifyContent="center">
      <box width={Math.min(60, ctx.width() - 4)} height={Math.min(opts().length * 2 + 4, 24)} border={true} borderStyle="rounded" borderColor={p.accent} backgroundColor={p.raised} paddingLeft={1} paddingRight={1} title={" " + title + " "} bottomTitle={" " + hint() + " "}>
        <select
          flexGrow={1}
          focused={true}
          options={opts().map((o) => ({ name: (o.now ? "● " : "  ") + o.text, description: o.hint, value: o.to }))}
          selectedIndex={now()}
          backgroundColor={p.raised}
          focusedBackgroundColor={p.raised}
          textColor={p.text}
          focusedTextColor={p.text}
          selectedBackgroundColor={p.sunk}
          selectedTextColor={p.accent}
          descriptionColor={p.faint}
          selectedDescriptionColor={p.muted}
          showDescription={true}
          wrapSelection={true}
          onSelect={(_: number, opt: { value?: string } | null) => {
            if (opt?.value !== undefined) {
              client_act(c, { $: "Move", move: props.move, to: opt.value });
            }
            props.close();
          }}
        />
      </box>
    </box>
  );
}

// Helpers
// =======

// a time as a clock reads it: "4s", "1m 20s"
function secs_show(s: number): string {
  const t = Math.floor(s);
  return t < 60 ? t + "s" : Math.floor(t / 60) + "m " + (t % 60) + "s";
}
