// Codex
// =====
// Codex's logs, read as messages.

import { import_date, msgs_of, parts_text, type Msg, type Session } from "./import.ts";

const INJECTED = /^(<[a-z_]+[ >]|# AGENTS\.md)/;

// an agent's rollout (source subagent, internal) is no person's chat
export function line_codex(s: Session, j: any, last: string): Msg[] {
  const p    = j.payload ?? {};
  const date = import_date(j.timestamp, last);
  if (j.type === "session_meta") {
    s.where = p.source?.subagent ?? p.source?.internal ? "" : "session in " + String(p.cwd ?? "");
  }
  return j.type === "response_item" && s.where !== "" ? item_codex(p, date) : [];
}

function item_codex(p: any, date: string): Msg[] {
  switch (p.type) {
    case "message": {
      const kind  = p.role === "user" ? "user" : p.role === "assistant" ? "unii" : null;
      const parts = (p.content ?? []).filter((c: any) => !INJECTED.test(c.text ?? ""));
      return kind === null ? [] : msgs_of(kind, parts_text(parts), date);
    }
    case "function_call": {
      return msgs_of("tool", p.name + " " + p.arguments, date);
    }
    case "custom_tool_call": {
      return msgs_of("tool", p.name + " " + JSON.stringify({ input: p.input }), date);
    }
    case "local_shell_call": {
      return msgs_of("tool", "shell " + JSON.stringify({ command: p.action?.command }), date);
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      return msgs_of("echo", parts_text(p.output), date);
    }
  }
  return [];
}
