// Ctx
// ===
// What every part of the UI reads: the client, its colors and syntax
// style, the spinner's frame, whether every tool's output shows (Ctrl+O),
// the terminal's width.

import type { SyntaxStyle } from "@opentui/core";
import { createContext, useContext, type Accessor } from "solid-js";
import type { Client } from "./client.ts";
import type { Palette } from "./palette.ts";

export type Ctx = {
  c       : Client;
  p       : Palette;
  syntax  : SyntaxStyle;
  spin    : Accessor<string>;
  outputs : Accessor<boolean>;
  width   : Accessor<number>;
};

export const CtxOf = createContext<Ctx>();

export function useCtx(): Ctx {
  const ctx = useContext(CtxOf);
  if (ctx === undefined) {
    throw new Error("no Ctx");
  }
  return ctx;
}

// the spinner's frames
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
