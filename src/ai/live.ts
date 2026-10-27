// Live
// ====
// What streams from a call, kept as pieces of one kind. Imported by the
// server and both views, so it imports only types.

import type {Kind} from "./ask-ai.ts"

// Types
// =====

// a piece of a message streaming, of one kind
export type Live = {kind: Kind; text: string}

// Live
// ====

// a piece joins the message streaming, if of its kind, unless it starts
// one (fresh: a tool call, as two calls never join)
export function live_push(
  live: Live[],
  kind: Kind,
  text: string,
  fresh = false
): void {
  const top = live[live.length - 1]
  if (top !== undefined && top.kind === kind && !fresh) {
    top.text += text
  } else {
    live.push({kind, text})
  }
}
