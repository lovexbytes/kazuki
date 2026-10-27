// Import
// ======
// A person's past Claude and ChatGPT chats (APPS), read into their chat:
// those on their computer (Claude Code's and Codex's logs), by the
// terminal (src/cli.ts `/import`), and those on the websites, from the
// zip each mails on request
// (import_export). A session (a log; a site's chat) is streamed twice:
// for its messages' heads (the count and the estimate), then the heads
// picked (Want) as JSON lines (import_body): a note, then its messages
// (pages), oldest first; never thinking. Its summaries run on the
// compactor (config.ts COMPACTOR). A session imported before (import_key)
// brings only its new messages.
//
// The estimate is the run's plan (import_guess): each node whose source
// is over NODE takes a call, priced as measured on the compactor (PRICE).
// It is shown, never a cap: the import runs on the user's own API keys.

import type {Kind} from "../ai/ask-ai.ts"
import {clip_pages, stream_lines} from "../util/clip.ts"
import {line_claude} from "./claude-code.ts"
import {line_codex} from "./codex.ts"

// Types
// =====

// a message (a page) as imported: its date ISO, whether the next goes on
// with its text
export type Msg = {kind: Kind; text: string; date: string; more?: boolean}

// a message as the count and the estimate read it: its size, import_size;
// its place in its session
export type Head = {kind: Kind; date: string; size: number; n: number}

// how a session's file reads: a log (Claude Code's or Codex's, told by
// its first line), or its messages as JSON lines (a site's chat)
export type Form = "log" | "msgs"

// a session: its app (APPS), its form, where it was (a log: "session in
// <cwd>"; a site's chat: 'chat "<title>"'), its first message's date,
// its file, its messages' heads
export type Session = {
  app: string
  form: Form
  where: string
  start: string
  file: Blob
  heads: Head[]
}

// the sessions imported before, by import_key: their last message's date
export type Done = Record<string, string>

// what an import takes: the sessions read but those left out (off:
// import_id), the messages from a day on ("": all), tool calls or not
export type Want = {off: string[]; since: string; tools: boolean}

// an import: the sessions as wanted but for off, those picked, their
// messages, the first new message's day ("": none), its cost in USD
export type Plan = {
  sessions: Session[]
  picked: Session[]
  msgs: number
  first: string
  guess: number
}

// a node as the estimate sees it: its source's bytes, and the summaries
// under it (0: its source is messages as they are)
export type Node = {bytes: number; depth: number}

// Constants
// =========

// Memory's NODE
const NODE = 512

// a summary's bytes (the compactor writes 460-510)
const LINE = 480

// what a compaction call costs on the compactor (config.ts COMPACTOR, its
// 16-32 KB view), in micro-USD: base, `byte` a doubling of its source past
// NODE, `depth` a summary under it (its own too); no view term: the view
// is read from cache, and a view term fit here takes a negative base; fit
// on 5,617 compaction calls of real imports
const PRICE = {base: 187, byte: 735, depth: 628}

// what import_body yields at least (characters), so no piece holds an
// import whole
const PART = 2 ** 20

// the apps a session is of: two sources, each its program on the
// computer and its website
export const APPS = ["Claude", "ChatGPT"]

// sessions all imported before
export const OLD = "Nothing new: these chats are in Kazuki's memory already."

// a session's day and count as listed (import_cells), made once
const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric"
})
const COUNT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0
})

// where each app's website gives its export, a zip it emails (said where
// one is taken)
export const EXPORTS: Record<string, string> = {
  Claude: "Settings › Privacy › Export data",
  ChatGPT: "Settings › Data controls › Export data"
}

// Import
// ======

// a path the import reads: a session's file
export function import_file(path: string): boolean {
  const session = /(^|\/)(projects|sessions|archived_sessions)\//.test(path)
  return session && path.endsWith(".jsonl") && !path.includes("subagents/")
}

// a session's file read for its heads (a log's app and where are told by
// its lines); null: no messages
export async function import_session(
  file: Blob,
  form: Form,
  app = "",
  where = ""
): Promise<Session | null> {
  const s: Session = {app, form, where, start: "", file, heads: []}
  for await (const m of import_read(s)) {
    s.heads.push({
      kind: m.kind,
      date: m.date,
      size: import_size(m),
      n: s.heads.length
    })
  }
  s.start = s.heads[0]?.date ?? ""
  return s.heads.length > 0 ? s : null
}

// a session's messages, its file read a line at a time
export async function* import_read(s: Session): AsyncGenerator<Msg> {
  let date = ""
  for await (const lines of stream_lines(s.file.stream())) {
    for (const line of lines) {
      const msgs = line_msgs(s, line, date)
      date = msgs.at(-1)?.date ?? date
      yield* msgs
    }
  }
}

// a log's line: a Codex log (first line session_meta) is a ChatGPT
// session, a Claude Code log a Claude one
function line_log(s: Session, j: any, last: string): Msg[] {
  s.app ||= j.type === "session_meta" ? "ChatGPT" : "Claude"
  return s.app === "ChatGPT" ? line_codex(s, j, last) : line_claude(s, j, last)
}

// a line's messages; none if it is no JSON, or JSON of a shape its reader
// can't take (a log is another app's file: one odd line, a null, a bad
// date, never fails its session, nor the import of all the others)
function line_msgs(s: Session, line: string, last: string): Msg[] {
  try {
    const j = JSON.parse(line)
    return s.form === "msgs" ? [j] : line_log(s, j, last)
  } catch {
    return []
  }
}

// the sessions oldest first, with the heads kept only
function import_pick(sessions: Session[], want: Want, done: Done): Session[] {
  const old = [...sessions].sort((a, b) => a.start.localeCompare(b.start))
  const keep = (m: Head, last?: string) =>
    (want.tools || m.kind === "user" || m.kind === "unii") &&
    m.date >= want.since &&
    import_new(m, last)
  const kept = (s: Session, last?: string) =>
    s.heads.filter((m) => keep(m, last))
  return old
    .map((s) => ({...s, heads: kept(s, done[import_id(s)])}))
    .filter((s) => s.heads.length > 0)
}

// the sessions found, as an import into a chat of `count` messages
export function import_plan(
  sessions: Session[],
  want: Want,
  done: Done,
  count: number
): Plan {
  const all = import_pick(sessions, {...want, since: ""}, done)
  const shown = import_pick(all, want, {})
  const picked = shown.filter((s) => !want.off.includes(import_id(s)))
  const first = all.map((s) => s.heads[0].date).sort()[0] ?? ""
  const sizes = picked.flatMap((s) => [
    import_size(import_note(s)),
    ...s.heads.map((m) => m.size)
  ])
  return {
    sessions: shown,
    picked,
    msgs: sizes.length - picked.length,
    first: first.slice(0, 10),
    guess: import_usd(count, sizes)
  }
}

// whether a message of a session imported up to `last` (none: never) is
// new: dated after it
export function import_new(
  m: {date?: string},
  last: string | undefined
): boolean {
  return last === undefined || (m.date ?? "") > last
}

// a session: the app, where, when
function import_name(s: Session): string {
  return (
    s.app +
    " " +
    s.where +
    ", from " +
    new Date(s.start).toLocaleString("sv-SE").slice(0, 16)
  )
}

// a session as listed to pick, under its app, in columns of one width
// each: its day, its messages at a glance, where (a folder short, a
// chat's title): ["Oct 07, 2026", "12k", "~/code/…/app/src"]
export function import_cells(s: Session): string[] {
  const day = DAY.format(new Date(s.start))
  const where = s.where.startsWith("session in ")
    ? path_short(s.where.slice(11))
    : s.where.replace(/^chat "(.*)"$/, "$1") || "untitled"
  return [day, count_short(s.heads.length), where]
}

// a session as one line ("Oct 07, 2026 · 34 · ~/code/…/app/src")
export function import_line(s: Session): string {
  return import_cells(s).join(" · ")
}

// a count in at most 4 characters: 999, 12k, 3m
function count_short(n: number): string {
  return COUNT.format(n).toLowerCase()
}

// a folder as read at a glance: home as ~, and past three folders the
// first and the last two, the middle as … ("~/code/…/app/src")
export function path_short(path: string): string {
  const parts = path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~").split("/")
  const head = parts[0] === "" ? 2 : 1
  return parts.length - head > 3
    ? [...parts.slice(0, head + 1), "…", ...parts.slice(-2)].join("/")
    : parts.join("/")
}

// a session as it opens
function import_note(s: Session): Msg {
  return {kind: "note", text: `${import_name(s)} (imported)`, date: s.start}
}

// a session's name in Done (its note's) and in Want.off
export function import_id(s: Session): string {
  return import_key(import_note(s))
}

// a session's name in Done: its note's date and where (its text less the
// app's name, whatever it was, and the time: the date's, in the zone of
// whoever imported it, so another zone named every session anew)
export function import_key(note: {text: string; date?: string}): string {
  return (
    note.date +
    " " +
    note.text
      .replace(/^.*?(?= session in | chat ")/, "")
      .replace(/, from [^,]*$/, "")
  )
}

// the sessions picked, each its note, then its heads' messages, as JSON
// lines, read again from its file, a PART at least at a time
export async function* import_body(picked: Session[]): AsyncGenerator<string> {
  let part = ""
  for (const s of picked) {
    const kept = new Set(s.heads.map((m) => m.n))
    let n = 0
    part += `${JSON.stringify(import_note(s))}\n`
    for await (const m of import_read(s)) {
      part += kept.has(n) ? `${JSON.stringify(m)}\n` : ""
      n += 1
      if (part.length >= PART) {
        yield part
        part = ""
      }
    }
  }
  yield part
}

// by level, what each node of messages of these sizes appended to a chat
// of `a` costs (micro-USD): the import's nodes (their last message its:
// memory.ts), each its node_usd; a leaf's source is its message, a
// merge's its two children's lines (node_line; a chat's own older one, a
// summary as deep as it)
export function import_guess(a: number, sizes: number[]): number[][] {
  const usd: number[][] = []
  let nodes: Node[] = sizes.map((bytes) => ({bytes, depth: 0}))
  for (let l = 0, i = a; nodes.length > 0; l += 1, i = Math.floor(i / 2)) {
    usd.push(nodes.map(node_usd))
    const [depth, now] = [l, nodes]
    const line = (k: number) =>
      k < 0 ? {bytes: LINE, depth} : node_line(now[k])
    const from = Math.floor(i / 2)
    nodes = Array.from(
      {length: Math.floor((i + nodes.length) / 2) - from},
      (_, j) =>
        node_merge(line(2 * (from + j) - i), line(2 * (from + j) + 1 - i))
    )
  }
  return usd
}

// import_guess's total (USD)
export function import_usd(a: number, sizes: number[]): number {
  return (
    import_guess(a, sizes)
      .flat()
      .reduce((x, y) => x + y, 0) / 1e6
  )
}

// a message's bytes as summarized
export function import_size(m: {kind: Kind; text: string}): number {
  return new TextEncoder().encode(`${m.kind}: ${m.text}`).length
}

// "1 message", "2,048 new messages" (what: "new ")
export function import_count(n: number, what: string): string {
  return `${n.toLocaleString("en-US")} ${what}${n === 1 ? "message" : "messages"}`
}

// "$3.10"
export function guess_usd(usd: number): string {
  return `$${Math.max(0.01, usd).toFixed(2)}`
}

// Node
// ====

// a node's cost (micro-USD, whole): none if its source fits, else a
// call's (PRICE)
function node_usd(node: Node): number {
  if (node.bytes <= NODE) {
    return 0
  }
  const {base, byte, depth} = PRICE
  return Math.round(
    base + byte * Math.log2(node.bytes / NODE) + depth * (node.depth + 1)
  )
}

// a node's line: its source if it fits, else a summary one deeper
function node_line(node: Node): Node {
  return node.bytes > NODE
    ? {bytes: LINE, depth: node.depth + 1}
    : {bytes: node.bytes, depth: 0}
}

// two lines merged: a node over both (and the newline between)
function node_merge(a: Node, b: Node): Node {
  return {bytes: a.bytes + 1 + b.bytes, depth: Math.max(a.depth, b.depth)}
}

// Msgs
// ====

// a time as ISO (as the server logs it): a log's or Claude's site's
// string, ChatGPT's seconds; none or bad: `last`
export function import_date(at: unknown, last: string): string {
  const ms = typeof at === "number" ? at * 1000 : Date.parse(String(at))
  return Number.isNaN(ms) ? last : new Date(ms).toISOString()
}

// a message in its pages
export function msgs_of(kind: Kind, text: string, date: string): Msg[] {
  const pages = text.trim() === "" ? [] : clip_pages(text)
  return pages.map((page, k) => ({
    kind,
    text: page,
    date,
    more: k < pages.length - 1
  }))
}

// content as text: a string, or parts (texts, images)
export function parts_text(content: any): string {
  if (typeof content === "string") {
    return content
  }
  const parts = Array.isArray(content) ? content : []
  return parts
    .map((c: any) =>
      typeof c === "string"
        ? c
        : typeof c.text === "string"
          ? c.text
          : String(c.type ?? c.content_type).includes("image")
            ? "[image]"
            : ""
    )
    .join("\n")
}
