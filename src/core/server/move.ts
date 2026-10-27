// Moving
// ------
// a chat given to another process and taken from one.

import type {Call, Event} from "../../ai/ask-ai.ts"
import {Memory} from "../memory.ts"
import {Tools} from "../tools.ts"
import {MOVE} from "../../view/view.ts"
import type {Moved, Peer} from "./shared.ts"
import {Chat} from "./chat.ts"
import {Handover} from "./handover.ts"
import {Ingest} from "./ingest.ts"
import {noop} from "../../util/noop.ts"

export namespace Move {
  // the chat moves to `peer`'s process, whose tools are at `url`, once no
  // post of it runs; no summary starts meanwhile, and those running go
  // along (Memory.give): waiting for them hung the chat (an import's run
  // on), cutting them asked each again there
  export function give(chat: Chat, peer: Peer, url: string): void {
    Memory.halt(chat.mem)
    chat.ending = {all: false, then: () => Move.move(chat, peer, url)}
    Chat.free(chat)
  }

  // the chat moves: what it runs goes on there (its calls by Handover.away),
  // and its views open again there
  export function move(chat: Chat, peer: Peer, url: string): void {
    const user = chat.acct.user
    const far = (call: Call) => Handover.away(peer, call)
    const {busy, model, sent, wait, asked, open, live, calls, eye} = chat
    const check = chat.check && {
      call: far(chat.check.call),
      goal: chat.check.goal
    }
    const turn = {
      busy,
      call: chat.call && far(chat.call),
      model,
      check,
      sent,
      wait,
      asked,
      open,
      live,
      calls,
      eye
    }
    const tools = Tools.give(chat.tools, url, far)
    if (chat.batch !== null) {
      Ingest.keep(chat.batch, chat)
    }
    const sums = Memory.give(chat.mem, far)
    Chat.chats.delete(user)
    Memory.stop(chat.mem)
    peer.send({$: "chat", moved: {user, turn, tools, sums}})
    chat.socks.forEach((sock) => sock.close(MOVE))
    Handover.done()
  }

  // a chat moved here (Move.move) goes on: its turn, agents and summaries,
  // each call running there by Handover.far
  export function arrive(chat: Chat, moved: Moved, peer: Peer): void {
    const {call, check, ...turn} = moved.turn
    const far = (id: string, on: (ev: Event) => void) =>
      Handover.far(peer, id, chat.tools.key, on)
    Object.assign(chat, turn)
    Tools.take(chat.tools, moved.tools, far)
    Memory.take(chat.mem, moved.sums, (id) => far(id, noop))
    if (turn.busy) {
      const run =
        call === null ? null : far(call, (ev) => Chat.on(chat, null, ev))
      if (run !== null) {
        chat.call = run
      }
      const checking = check
        ? {call: far(check.call, noop), goal: check.goal}
        : null
      Chat.turn(
        chat,
        run
          ? Chat.ended(chat, run, chat.halt)
          : checking && Chat.checked(chat, checking, chat.halt)
      )
    }
  }
}
