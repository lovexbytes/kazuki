// Export
// ======
// A site's export (Claude's or ChatGPT's zip), read as sessions, one a chat.

import {caught, Err, Ok, type Result} from "../util/result.ts"
import {zip_file} from "../util/zip.ts"
import {blocks_msgs} from "./claude-code.ts"
import {
  import_date,
  import_session,
  msgs_of,
  parts_text,
  type Msg,
  type Session
} from "./import.ts"

// a file given as a site's export that is none (import_export)
const NOT_EXPORT = "Not a Claude or ChatGPT export."

// a site's export, its zip (conversations.json in it) or that file alone,
// as sessions, one a chat: ChatGPT's (a tree, `mapping`) or Claude's
// (`chat_messages`); a file not a list of those is no export
export async function import_export(
  file: Blob
): Promise<Result<Session[], Error>> {
  try {
    const zip = (await file.slice(0, 2).text()) === "PK"
    const json = zip ? await zip_file(file, "conversations.json") : file
    if (json === null) {
      return new Err(new Error("No conversations.json in the zip."))
    }
    const chats = await json
      .text()
      .then(JSON.parse)
      .catch(() => null)
    if (
      !(
        Array.isArray(chats) &&
        chats.every(
          (chat) =>
            chat?.mapping !== undefined || Array.isArray(chat?.chat_messages)
        )
      )
    ) {
      return new Err(new Error(NOT_EXPORT))
    }
    const sessions = await Promise.all(chats.map(chat_session))
    return new Ok(sessions.filter((s) => s !== null))
  } catch (e) {
    return caught(e)
  }
}

// a chat as a session: its messages as JSON lines, its title as where
function chat_session(chat: any): Promise<Session | null> {
  const [app, msgs] = chat.mapping
    ? ["ChatGPT", chat_openai(chat)]
    : ["Claude", chat_claude(chat)]
  const file = new Blob(msgs.map((m) => `${JSON.stringify(m)}\n`))
  return import_session(
    file,
    "msgs",
    app,
    `chat "${String(chat.title ?? chat.name ?? "")}"`
  )
}

// a ChatGPT chat's messages: its thread shown, current_node up to the
// root (an edit or a retry leaves its old branch); a person's say,
// ChatGPT's, what it sent a tool (recipient) as a call, a tool's output
// as an echo; never thoughts, nor a hidden one
function chat_openai(chat: any): Msg[] {
  const nodes: any[] = []
  for (let id = chat.current_node; id; id = chat.mapping[id]?.parent) {
    nodes.unshift(chat.mapping[id]?.message)
  }
  let date = import_date(chat.create_time, "")
  return nodes.flatMap((m) => {
    const role = m?.author?.role
    const type = String(m?.content?.content_type)
    const kind =
      role === "user"
        ? "user"
        : role === "assistant"
          ? m.recipient === "all"
            ? "kazuki"
            : "tool"
          : role === "tool"
            ? "echo"
            : null
    const skip =
      kind === null ||
      m.metadata?.is_visually_hidden_from_conversation === true ||
      type === "thoughts" ||
      type === "reasoning_recap"
    date = import_date(m?.create_time, date)
    return skip
      ? []
      : msgs_of(
          kind,
          (kind === "tool" ? `${m.recipient} ` : "") +
            parts_text(m.content.parts ?? [m.content.text]),
          date
        )
  })
}

// a Claude website chat's messages, in order: a person's say (its texts and
// its files' names), Claude's, their tool calls and results (Claude's
// blocks, as Claude Code's); never thinking
function chat_claude(chat: any): Msg[] {
  let date = import_date(chat.created_at, "")
  return (chat.chat_messages ?? []).flatMap((m: any) => {
    date = import_date(m.created_at, date)
    const kind = m.sender === "human" ? "user" : "kazuki"
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{type: "text", text: String(m.text ?? "")}]
    const files = [...(m.attachments ?? []), ...(m.files ?? [])].map(
      (f: any) => ({type: "text", text: `[file ${f.file_name}]`})
    )
    return blocks_msgs(kind, [...blocks, ...files], date)
  })
}
