// Tool
// ====
// A tool call as the transcript draws it, by its tool: a command and
// its output (shell); a file read, written or edited, its diff drawn as
// one (write, edit); the agents spawned and told (spawn, tell); a look
// into the memory (zoom, date); any other as its arguments and result.
// Each is a card on the raised fill, a spinner while it runs, its
// output folded to a few lines till clicked, whole till clicked again
// (Ctrl+O: all of them). A call opened from its summary shows whole, a
// click shuts it back. A read is a line, not a card: what it read is the
// model's, not yours.

import type { CliRenderer, MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createContext, createMemo, createSignal, For, Match, Show, Switch, useContext, type JSX } from "solid-js";
import * as Call from "../view/call.ts";
import { useCtx } from "./ctx.ts";
import { input_text, type Tool } from "./items.ts";
import { filetype } from "./palette.ts";

// Constants
// =========

// each tool's mark and name; any other's is ANY's
const MARK: Record<string, [string, string]> = {
  shell    : ["$", "Shell"],
  read     : ["→", "Read"],
  write    : ["←", "Write"],
  edit     : ["±", "Edit"],
  zoom     : ["◎", "Zoom"],
  date     : ["◷", "Date"],
  spawn    : ["◆", "Spawn"],
  tell     : ["✉", "Tell"],
  computer : ["▣", "Computer"],
};
const ANY: [string, string] = ["⚙", ""];

// a result's lines shown folded
const FOLDED = 8;

// a shell's lines shown folded, its command's and the fold's own with
// them; its command's lines at most
const SHELL   = 10;
const COMMAND = 2;

// a shell's last line: its exit and time (machine.ts shell)
const EXIT = /\n?\((exit \d+|stopped|killed by \w+) in ([\d.]+ s)\)$/;

// a read's last line: the lines it read (machine.ts read)
const LINES = /\n?\[(lines \d+-\d+ of \d+)[^\]]*\]$/;

// a unified diff's start
const DIFF = /^--- .*\n\+\+\+ /m;

// Tool
// ====

// a call opened from its summary: what shuts it
const ShutOf = createContext<(() => void) | undefined>();

export function ToolView(props: { t: Tool; shut?: () => void }): JSX.Element {
  const name = () => props.t.call.name;
  return (
    <ShutOf.Provider value={props.shut}>
      <Switch fallback={<Generic t={props.t} />}>
        <Match when={name() === "shell"}><Shell t={props.t} /></Match>
        <Match when={name() === "read"}><Read t={props.t} /></Match>
        <Match when={name() === "write" || name() === "edit"}><Change t={props.t} /></Match>
        <Match when={name() === "zoom" || name() === "date"}><Memory t={props.t} /></Match>
        <Match when={name() === "spawn" || name() === "tell" || name() === "computer"}><Task t={props.t} /></Match>
      </Switch>
    </ShutOf.Provider>
  );
}

// whether a card is open: as clicked, else as Ctrl+O says; one opened
// from its summary is open, a click shuts it
function useOpen(): [() => boolean, () => void] {
  const ctx  = useCtx();
  const shut = useContext(ShutOf);
  const [mine, setMine] = createSignal<boolean | null>(null);
  if (shut !== undefined) {
    return [() => true, shut];
  }
  return [() => mine() ?? ctx.outputs(), () => setMine(!(mine() ?? ctx.outputs()))];
}

// Parts
// =====

// a card: its head (top: its own instead), then its body, on the
// raised fill, a bar on its left colored by its state; a click (not a
// selection's end) toggles it
function Card(props: { t: Tool; title: string; head?: string; right?: string; top?: JSX.Element; onToggle?: () => void; children?: JSX.Element }): JSX.Element {
  const ctx = useCtx();
  const p   = ctx.p;
  const r   = useRenderer();
  const [hover, setHover] = createSignal(false);
  const bar = () => (props.t.live ? p.warn : props.t.fail ? p.error : hover() && props.onToggle ? p.accent : p.border);
  return (
    <box
      border={["left"]}
      borderColor={bar()}
      customBorderChars={THIN}
      backgroundColor={hover() && props.onToggle ? p.sunk : p.raised}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(e: MouseEvent) => click(e, props.onToggle, r)}
    >
      <Show when={props.top} fallback={<Head t={props.t} title={props.title} head={props.head} right={props.right} />}>
        {props.top}
      </Show>
      {props.children}
    </box>
  );
}

// a call's line: its mark (a spinner while it runs), its tool, its head,
// where it runs, and what it ended as on the right
function Head(props: { t: Tool; title: string; head?: string; right?: string }): JSX.Element {
  const ctx  = useCtx();
  const p    = ctx.p;
  const mark = () => (props.t.live ? ctx.spin() : (MARK[props.t.call.name] ?? ANY)[0]);
  const head = () => [props.head ?? "", props.t.call.device].filter((x) => x !== "").join(" · ");
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text flexShrink={0} fg={props.t.live ? p.warn : props.t.fail ? p.error : p.muted}>{mark()}</text>
      <text flexShrink={0} fg={p.text}><b>{props.title}</b></text>
      <text flexGrow={1} flexShrink={1} fg={p.muted} wrapMode="char" maxHeight={2}>{head()}</text>
      <Show when={props.right || props.t.stopped}>
        <text flexShrink={0} fg={props.t.fail ? p.error : p.faint}>{props.right || "stopped"}</text>
      </Show>
    </box>
  );
}

// a text's lines, folded to `most` (FOLDED) unless open, the fold's
// line among them, its count said; flat: on the card's fill, not sunk
function Output(props: { text: string; open: boolean; fail?: boolean; tail?: boolean; most?: number; flat?: boolean }): JSX.Element {
  const ctx   = useCtx();
  const p     = ctx.p;
  const lines = createMemo(() => props.text.replace(/\s+$/, "").split("\n"));
  const shown = createMemo(() => {
    const all  = lines();
    const most = props.most ?? FOLDED;
    if (props.open || all.length <= most) {
      return all;
    }
    return props.tail ? all.slice(-(most - 1)) : all.slice(0, most - 1);
  });
  const more = () => lines().length - shown().length;
  return (
    <Show when={props.text.trim() !== ""}>
      <box backgroundColor={props.flat ? undefined : p.sunk} paddingLeft={props.flat ? 0 : 1} paddingRight={props.flat ? 0 : 1} flexShrink={0}>
        <Show when={more() > 0 && props.tail}>
          <text fg={p.faint}>{"… " + more() + " lines above · click to show"}</text>
        </Show>
        <text fg={props.fail ? p.error : p.muted} wrapMode="char">{shown().join("\n")}</text>
        <Show when={more() > 0 && !props.tail}>
          <text fg={p.faint}>{"… " + more() + " more lines · click to show"}</text>
        </Show>
      </box>
    </Show>
  );
}

// Tools
// =====

// a shell: its command on top, as typed, and the output under it,
// muted (a command that ran and failed says so by its exit, its output
// as it printed it); folded, its last lines, the whole SHELL lines at most
function Shell(props: { t: Tool }): JSX.Element {
  const ctx = useCtx();
  const p   = ctx.p;
  const [open, toggle] = useOpen();
  const result = () => props.t.result ?? "";
  const exit   = createMemo(() => EXIT.exec(result()));
  const output = () => result().replace(EXIT, "");
  const right  = () => {
    const e    = exit();
    const ends = props.t.live ? "running" : props.t.stopped ? "stopped" : e === null ? "" : (e[1] === "exit 0" ? "" : e[1] + " · ") + e[2];
    return [props.t.call.device, ends].filter((x) => x !== "").join(" · ");
  };
  const failed = () => props.t.fail || (exit() !== null && exit()?.[1] !== "exit 0");
  // the command's lines as drawn, at most COMMAND (the card's own width:
  // its bar, paddings, mark)
  const rows = createMemo(() => {
    const width = Math.max(20, ctx.width() - 8 - right().length);
    const n     = props.t.call.head.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / width)), 0);
    return Math.min(COMMAND, n);
  });
  const top = (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text flexShrink={0} fg={props.t.live ? p.warn : failed() ? p.error : p.muted}>{props.t.live ? ctx.spin() : "$"}</text>
      <text flexGrow={1} flexShrink={1} fg={p.text} wrapMode="char" maxHeight={open() ? undefined : COMMAND}>{props.t.call.head}</text>
      <Show when={right() !== ""}>
        <text flexShrink={0} fg={failed() ? p.error : p.faint}>{right()}</text>
      </Show>
    </box>
  );
  return (
    <Card t={props.t} title="Shell" top={top} onToggle={toggle}>
      <Output text={output()} open={open()} fail={props.t.fail && exit() === null} most={SHELL - rows()} tail flat />
    </Card>
  );
}

// a read: a line, the file and the lines read; failed, why
function Read(props: { t: Tool }): JSX.Element {
  const ctx    = useCtx();
  const p      = ctx.p;
  const result = () => props.t.result ?? "";
  const lines  = () => LINES.exec(result())?.[1] ?? "";
  const head   = () => [props.t.call.head, props.t.call.device].filter((x) => x !== "").join(" · ");
  const right  = () => (props.t.live ? "" : props.t.fail ? "failed" : props.t.stopped ? "stopped" : lines());
  // opened from its summary: a click shuts it
  const shut   = useContext(ShutOf);
  const r      = useRenderer();
  const [hover, setHover] = createSignal(false);
  return (
    <box
      paddingLeft={2}
      paddingRight={1}
      flexShrink={0}
      backgroundColor={hover() && shut !== undefined ? p.raised : undefined}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(e: MouseEvent) => click(e, shut, r)}
    >
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text flexShrink={0} fg={props.t.live ? p.warn : props.t.fail ? p.error : p.muted}>{props.t.live ? ctx.spin() : "→"}</text>
        <text flexShrink={0} fg={p.muted}>Read</text>
        <text flexGrow={1} flexShrink={1} fg={p.muted} wrapMode="char" maxHeight={1}>{head()}</text>
        <Show when={right() !== ""}>
          <text flexShrink={0} fg={props.t.fail ? p.error : p.faint}>{right()}</text>
        </Show>
      </box>
      <Show when={props.t.fail}>
        <text paddingLeft={2} fg={p.error} wrapMode="word">{result()}</text>
      </Show>
    </box>
  );
}

// a write or edit: its files, then each diff as the result gives it
function Change(props: { t: Tool }): JSX.Element {
  const [open, toggle] = useOpen();
  const name   = () => props.t.call.name;
  const path   = () => input_text(props.t, "path") || props.t.call.head;
  const result = () => props.t.result ?? "";
  const diff   = createMemo(() => {
    const at = result().search(DIFF);
    return at < 0 || props.t.fail ? "" : result().slice(at);
  });
  const count  = createMemo(() => diff_count(diff()));
  const right  = () => (props.t.live ? "" : props.t.fail ? "failed" : count());
  // a write still streaming shows what it writes
  const draft  = () => (name() === "write" && diff() === "" && !props.t.fail ? input_text(props.t, "content") : "");
  return (
    <Card t={props.t} title={name() === "write" ? "Write" : "Edit"} head={props.t.call.head} right={right()} onToggle={toggle}>
      <Show when={props.t.fail}>
        <Output text={result()} open={true} fail />
      </Show>
      <Show when={diff() !== ""}>
        <Diff text={diff()} path={path()} open={open()} />
      </Show>
      <Show when={draft() !== ""}>
        <Output text={draft()} open={open()} tail={props.t.live} />
      </Show>
    </Card>
  );
}

// a unified diff, its lines colored as added or dropped; folded, its
// first hunks' lines
function Diff(props: { text: string; path: string; open: boolean }): JSX.Element {
  const ctx = useCtx();
  const p   = ctx.p;
  const all = createMemo(() => props.text.split("\n"));
  // folded: the diff cut at a line, its file head kept (DiffRenderable
  // reads the hunks it holds)
  const shown = createMemo(() => (props.open ? props.text : diff_fold(all(), 3 * FOLDED)));
  const more  = () => all().length - shown().split("\n").length;
  return (
    <box flexShrink={0}>
      <diff
        syntaxStyle={ctx.syntax}
        view={ctx.width() > 140 ? "split" : "unified"}
        filetype={filetype(props.path)}
        showLineNumbers={true}
        wrapMode="char"
        fg={p.text}
        addedBg={p.added}
        removedBg={p.removed}
        contextBg={p.sunk}
        addedSignColor={p.addedFg}
        removedSignColor={p.removedFg}
        lineNumberFg={p.faint}
        lineNumberBg={p.sunk}
        addedLineNumberBg={p.added}
        removedLineNumberBg={p.removed}
        diff={shown()}
      />
      <Show when={more() > 0}>
        <text fg={p.faint}>{"… " + more() + " more lines · click to show"}</text>
      </Show>
    </box>
  );
}

// a zoom or a date: a look into the memory, its result folded
function Memory(props: { t: Tool }): JSX.Element {
  const [open, toggle] = useOpen();
  const name = () => MARK[props.t.call.name][1];
  const n    = () => line_count(props.t.result ?? "");
  return (
    <Card t={props.t} title={name()} head={props.t.call.head} right={props.t.live ? "" : n()} onToggle={toggle}>
      <Show when={open() || props.t.fail}>
        <Output text={props.t.result ?? ""} open={open()} fail={props.t.fail} />
      </Show>
    </Card>
  );
}

// a spawn, a tell or a computer's task: the head, each task's text
function Task(props: { t: Tool }): JSX.Element {
  const ctx = useCtx();
  const p   = ctx.p;
  const [open, toggle] = useOpen();
  const title = () => MARK[props.t.call.name][1];
  return (
    <Card t={props.t} title={title()} head={props.t.call.head} onToggle={toggle}>
      <For each={props.t.call.blocks}>
        {(b, k) => (
          <box flexDirection="row" flexShrink={0}>
            <text flexShrink={0} fg={p.agent}>{props.t.call.blocks.length > 1 ? String(k() + 1).padStart(2) + ". " : "  "}</text>
            <text flexGrow={1} fg={p.text} wrapMode="word" maxHeight={open() ? undefined : 3}>{b.x}</text>
          </box>
        )}
      </For>
      <Show when={props.t.result !== null && (open() || props.t.fail)}>
        <Output text={props.t.result ?? ""} open={open()} fail={props.t.fail} />
      </Show>
    </Card>
  );
}

// any other call: its name and short arguments, each long one in a
// block, then its result
function Generic(props: { t: Tool }): JSX.Element {
  const ctx = useCtx();
  const p   = ctx.p;
  const [open, toggle] = useOpen();
  const title = () => props.t.call.name || "Tool";
  return (
    <Card t={props.t} title={title()} head={props.t.call.head} right={props.t.live ? "" : line_count(props.t.result ?? "")} onToggle={toggle}>
      <For each={props.t.call.blocks}>
        {(b) => (
          <box flexShrink={0}>
            <Show when={b.k !== ""}>
              <text fg={p.faint}>{b.k}</text>
            </Show>
            <text fg={p.muted} wrapMode="char" maxHeight={open() ? undefined : 4}>{b.x}</text>
          </box>
        )}
      </For>
      <Show when={props.t.result !== null}>
        <Output text={props.t.result ?? ""} open={open()} fail={props.t.fail} />
      </Show>
    </Card>
  );
}

// A summary that is a tool call word for word (view.ts sum_call): its
// line, drawn as a call, folded
export function CallLine(props: { call: Call.Call }): JSX.Element {
  const ctx  = useCtx();
  const p    = ctx.p;
  const mark = () => (MARK[props.call.name] ?? ANY)[0];
  const name = () => (MARK[props.call.name] ?? ["", props.call.name])[1] || props.call.name;
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text flexShrink={0} fg={p.faint}>{mark()}</text>
      <text flexShrink={0} fg={p.muted}>{name()}</text>
      <text flexGrow={1} fg={p.faint} wrapMode="char" maxHeight={1}>{Call.call_line(props.call)}</text>
    </box>
  );
}

// Helpers
// =======

// a left edge one line thin
export const THIN = {
  topLeft: "", bottomLeft: "", vertical: "┃", topRight: "", bottomRight: "", horizontal: " ",
  bottomT: "", topT: "", cross: "", leftT: "", rightT: "",
};

// a click that ends no selection runs f
export function click(e: MouseEvent, f: (() => void) | undefined, r: CliRenderer): void {
  if (f === undefined || e.button !== 0 || r.getSelection()?.getSelectedText()) {
    return;
  }
  e.stopPropagation();
  f();
}

// "+3 −1": a diff's lines added and dropped
function diff_count(diff: string): string {
  let [add, del] = [0, 0];
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) {
      add++;
    } else if (l.startsWith("-") && !l.startsWith("---")) {
      del++;
    }
  }
  return diff === "" ? "" : "+" + add + " −" + del;
}

// a diff's first `most` lines, its last hunk's header counts cut to
// what is kept (so the hunk parses)
function diff_fold(lines: string[], most: number): string {
  if (lines.length <= most) {
    return lines.join("\n");
  }
  const kept = lines.slice(0, most);
  const head = kept.findLastIndex((l) => l.startsWith("@@"));
  if (head < 0) {
    return kept.join("\n");
  }
  // a "\ No newline" mark and a next file's head are no hunk's lines
  const body = kept.slice(head + 1).filter((l) => !l.startsWith("\\") && !l.startsWith("--- ") && !l.startsWith("+++ "));
  const olds = body.filter((l) => !l.startsWith("+")).length;
  const news = body.filter((l) => !l.startsWith("-")).length;
  const m    = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(kept[head]);
  if (m === null) {
    return kept.join("\n");
  }
  kept[head] = "@@ -" + m[1] + "," + olds + " +" + m[2] + "," + news + " @@" + m[3];
  return kept.join("\n");
}

function line_count(text: string): string {
  const n = text.trim() === "" ? 0 : text.trim().split("\n").length;
  return n === 0 ? "" : n + (n === 1 ? " line" : " lines");
}
