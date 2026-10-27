// Claude Code
// ===========
// Claude Code's logs, read as messages.

import type {Kind} from "../ai/ask-ai.ts"
import {
  import_date,
  msgs_of,
  parts_text,
  type Msg,
  type Session
} from "./import.ts"

const SKIP = /^(<command-|<local-command|\[Request interrupted)/

// a line's say (its texts and images) is one message; then its tools;
// a line without a timestamp is of the last message's date
export function line_claude(s: Session, j: any, last: string): Msg[] {
  const date = import_date(j.timestamp, last)
  const own =
    (j.type === "user" || j.type === "assistant") &&
    !j.isMeta &&
    !j.isSidechain &&
    !j.isCompactSummary
  const content = j.message?.content
  const blocks = own
    ? typeof content === "string"
      ? [{type: "text", text: content}]
      : Array.isArray(content)
        ? content
        : []
    : []
  s.where ||= j.cwd ? `session in ${j.cwd}` : ""
  if (j.type === "attachment" && j.attachment?.type === "queued_command") {
    return msgs_of("user", String(j.attachment.prompt ?? ""), date)
  }
  return blocks_msgs(j.type === "user" ? "user" : "unii", blocks, date)
}

// a say's blocks (Claude's shape: texts, images, tool calls and their
// results) as a message, its texts and images; then its calls, each its
// name and input, and their results
export function blocks_msgs(kind: Kind, blocks: any[], date: string): Msg[] {
  const say = blocks.filter(
    (b) => b.type === "image" || (b.type === "text" && !SKIP.test(b.text))
  )
  const tools = blocks.flatMap((b) =>
    b.type === "tool_use"
      ? msgs_of("tool", `${b.name} ${JSON.stringify(b.input)}`, date)
      : b.type === "tool_result"
        ? msgs_of("echo", parts_text(b.content), date)
        : []
  )
  return [...msgs_of(kind, parts_text(say), date), ...tools]
}
