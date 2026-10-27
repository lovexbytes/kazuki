// Theme
// =====
// The terminal's colors and glyphs. What the machine wrote is filled,
// what a person or Kazuki said is framed: a block (a summary) and a tool call sit on the
// `block` gray; every result is a file's lines (a read's, a write's or
// edit's diff, any other output's): framed, its name on the top edge,
// each line numbered; the user's message and
// a report sit in a frame; Kazuki's answer, its thinking and a note are bare.
// A call is named by its tool, a report or note by WHO; thinking
// is unnamed, told by its faint italic. Every tool
// is in ink; a diff's lines are
// green and red. The terminal paints no color of its own, only
// its own palette's (ANSI: text in its foreground, a fill in its gray),
// so it fits any theme, light or dark.

import type {Kind} from "../ai/ask-ai.ts"

// Constants
// =========

// the terminal's fill and the text on it ("7": its light gray, "0": its
// black), a diff's lines ("2": its green, "1": its red), as ANSI
// palette colors, so they follow the terminal's theme
export const ANSI = {block: "7", ink: "0", add: "2", del: "1", you: "4"}

// what a message is, named on its top (a report's frame edge, a note's
// first line; a result names itself on its frame's edge; a report: its agent's name, else this; a
// call: its tool). The user's words (framed) and Kazuki's (bare) need none
export const WHO: Record<string, string> = {work: "Report", note: "Note"}

// the kinds filled (the machine's); framed (the user's, an agent's); the
// rest (Kazuki's, thinking, notes) bare, any name over it
export const FILLED: Kind[] = ["tool"]
export const FRAMED: Kind[] = ["user", "work"]

export const GLYPH = {
  tab: "◯", // a chat's tab
  here: "●", // the tab of the chat shown
  input: "> ", // each line of the message typed
  open: "▾" // an open block's bar
}
