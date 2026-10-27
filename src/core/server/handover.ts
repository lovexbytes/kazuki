// Handover
// ========
// --------
// Worker k's successor reaches it at HAND + k (which leads to the
// newest's own address: Handover.listen), says go (its tools' URL), then
// listens for its own (a successor that dies before that leaves this
// one serving, reachable again). This one stops serving (its watch
// too), says its address, which chats it holds and which still come to
// it (a deploy during a deploy: the one before gives a chat only at
// rest, after a long post), and gives each on as it can (Move.give),
// those coming once they come. A call goes on in the process that
// started it, fed straight to its chat's process (Handover.away, Handover.far),
// so one that passed calls on ends once their origins feed the next.
// A process ends once nothing is left to come, run or pass
// on (Handover.done).

import * as fs from "node:fs"
import * as net from "node:net"
import {READING} from "../../ai/agent.ts"
import {
  AskAI,
  type Call,
  type End,
  type Event,
  type Say
} from "../../ai/ask-ai.ts"
import {Tools} from "../tools.ts"
import {Moved, Peer, Away, Gate, LEAVE, ENDED} from "./shared.ts"
import {Chat} from "./chat.ts"
import {Move} from "./move.ts"
import {Main} from "./main.ts"

export namespace Handover {
  // the process it took its chats from, its address, and the users whose
  // chats that one has yet to give (Handover.here), once it said which; the one
  // it gives its chats to, and whether it does
  export let back: Peer | null = null
  export let before = ""
  export const coming = new Map<string, PromiseWithResolvers<void>>()
  export let listed = Promise.withResolvers<void>()
  export let next: Peer | null = null
  export let given = false
  export let onward = ""

  // this process's address (Handover.listen); every line to another, and those
  // it opened to calls' origins, by address; the calls it feeds to where
  // their chats went (Handover.away) and those its relays still pass on to it
  // (Handover.far), by ref; each call's ref here, if fed from elsewhere
  export let addr = ""
  export const peers = new Set<Peer>()
  export const links = new Map<string, Peer>()
  export const aways = new Map<string, Away>()
  export const gates = new Map<string, Gate>()
  export const refs = new WeakMap<Call, string>()

  // the worker before this one, if one listens at `hand`
  export function dial(hand: string): Promise<Peer | null> {
    return new Promise((done) => {
      const sock = net.connect(hand)
      sock.once("connect", () => done(Handover.peer(sock)))
      sock.once("error", () => done(null))
    })
  }

  // this process's address, `hand` and its pid, which any process may
  // reach (a call's new process: Handover.far); once it listens, `hand`
  // leads to it, so the next worker k reaches this one
  export function listen(hand: string): void {
    const temp = hand + ".link"
    Handover.addr = hand + "." + process.pid
    fs.rmSync(Handover.addr, {force: true})
    net
      .createServer((sock) => Handover.peer(sock))
      .listen(Handover.addr, () => {
        fs.rmSync(temp, {force: true})
        fs.symlinkSync(Handover.addr, temp)
        fs.renameSync(temp, hand)
      })
  }

  // a peer over a socket, a line of JSON a message, each heard alone
  // (Main.event): one that fails (a chat moved here that won't open) is
  // logged, and the rest of the read (the chats moved after it) goes on
  export function peer(sock: net.Socket): Peer {
    const peer: Peer = {
      send: (msg) => sock.write(JSON.stringify(msg) + "\n"),
      end: (then) => (sock.destroyed ? then() : sock.end(then)),
      feeds: new Map()
    }
    let rest = ""
    Handover.peers.add(peer)
    sock.setEncoding("utf8")
    sock.on("data", (data: string) => {
      const lines = (rest + data).split("\n")
      rest = lines.pop()!
      lines.forEach((line) =>
        Main.event("a message of another worker", () =>
          Handover.told(peer, JSON.parse(line))
        )
      )
    })
    sock.on("error", () => {})
    sock.on("close", () => Handover.lost(peer))
    return peer
  }

  // the process at `addr` (a call's origin: Handover.far), by one line
  export function link(addr: string): Peer {
    const known = Handover.links.get(addr)
    if (known !== undefined) {
      return known
    }
    const peer = Handover.peer(net.connect(addr))
    Handover.links.set(addr, peer)
    return peer
  }

  // a peer's message; a chat moved here frees its user's requests first,
  // so one that won't open is opened by them anew, as after a restart
  // (Chat.open: it was never kept half open). What a call's origin sends
  // while its relay still passes on is held (Handover.far)
  export function told(peer: Peer, msg: any): void {
    const gate = Handover.gates.get(msg.call)
    if (gate?.origin === peer) {
      gate.held.push(msg)
      return
    }
    switch (msg.$) {
      case "go": {
        if (Handover.next !== null) {
          return peer.end(() => {})
        }
        Handover.next = peer
        Main.server.stop()
        Handover.given = true
        Handover.onward = msg.tools
        Handover.listed.promise
          .then(() => {
            peer.send({
              $: "users",
              addr: Handover.addr,
              users: [...Chat.chats.keys(), ...Handover.coming.keys()]
            })
            ;[...Chat.chats.values()].forEach((chat) =>
              Move.give(chat, peer, msg.tools)
            )
            Handover.done()
          })
          .catch((err) =>
            console.error(
              "kazuki: giving the chats failed: " + (err?.stack ?? err)
            )
          )
        return
      }
      case "users": {
        Handover.before = msg.addr ?? ""
        ;(msg.users as string[]).forEach((user) =>
          Handover.coming.set(user, Promise.withResolvers())
        )
        Handover.listed.resolve()
        return
      }
      case "chat": {
        const moved: Moved = msg.moved
        Handover.coming.get(moved.user)?.resolve()
        Handover.coming.delete(moved.user)
        const chat = Chat.open({id: moved.user, name: ""}, moved, peer)
        if (chat !== null && Handover.given) {
          Move.give(chat, Handover.next!, Handover.onward)
        }
        Handover.done()
        return
      }
      case "ev": {
        peer.feeds.get(msg.call)?.on(msg.ev)
        return
      }
      case "end": {
        peer.feeds.get(msg.call)?.end(msg.end)
        peer.feeds.delete(msg.call)
        gate?.origin.feeds.delete(msg.call)
        Handover.gates.delete(msg.call)
        return
      }
      case "take": {
        Tools.went(msg.key, msg.tools)
        const away = Handover.aways.get(msg.call)
        if (away !== undefined) {
          away.link.send({$: "gone", call: msg.call})
          away.link = peer
        }
        return
      }
      case "gone": {
        if (gate !== undefined) {
          return Handover.open(msg.call, gate)
        }
        peer.feeds.delete(msg.call)
        Handover.aways.get(msg.call)?.link.send(msg)
        Handover.aways.delete(msg.call)
        Handover.done()
        return
      }
      case "send": {
        Handover.aways.get(msg.call)?.call.send(msg.say)
        return
      }
      case "stop": {
        Handover.aways.get(msg.call)?.call.stop()
        return
      }
    }
  }

  // a call moved with its chat to `peer`'s process: what it sends and
  // ends goes where the chat is, by its ref: this process's address and
  // an id, or, fed here from further back, its own, passed on till its
  // origin feeds the chat's process itself (gone)
  export function away(peer: Peer, call: Call): string {
    const ref =
      Handover.refs.get(call) ?? Handover.addr + "#" + crypto.randomUUID()
    const away: Away = {call, link: peer}
    const end = (end: End) => {
      Handover.aways.delete(ref)
      away.link.send({$: "end", call: ref, end})
      Handover.done()
    }
    Handover.aways.set(ref, away)
    call.move({on: (ev) => away.link.send({$: "ev", call: ref, ev}), end})
    return ref
  }

  // the call `ref` running elsewhere for a chat moved here from `back`: fed by
  // `back` if it runs there, else by its origin, asked to (take; its MCP
  // requests for the chat `key` then come straight here: Tools.went), what that
  // sends held till `back` passed on all that reached it (gone)
  export function far(
    back: Peer,
    ref: string,
    key: string,
    on: (ev: Event) => void
  ): Call {
    const at = ref.slice(0, Math.max(0, ref.lastIndexOf("#")))
    const origin = at === Handover.before ? back : Handover.link(at)
    const send = (say: Say) => origin.send({$: "send", call: ref, say})
    const [call, feed] = AskAI.tie(on, send, () =>
      origin.send({$: "stop", call: ref})
    )
    back.feeds.set(ref, feed)
    origin.feeds.set(ref, feed)
    if (origin !== back) {
      Handover.gates.set(ref, {relay: back, origin, held: [], lost: false})
      origin.send({$: "take", call: ref, key, tools: Tools.base()})
    }
    Handover.refs.set(call, ref)
    return call
  }

  // a call's relay passed on all that reached it: what its origin sent
  // since goes on, then the end its lost line meant
  export function open(ref: string, gate: Gate): void {
    Handover.gates.delete(ref)
    gate.relay.feeds.delete(ref)
    gate.held.forEach((msg) => Handover.told(gate.origin, msg))
    if (gate.lost) {
      gate.origin.feeds.get(ref)?.end(AskAI.end(ENDED))
      gate.origin.feeds.delete(ref)
    }
  }

  // once it gave all its chats and nothing it runs or passes on for them
  // is left, this process ends, its last requests answered (Handover.leave)
  export function done(): void {
    if (
      Handover.given &&
      Chat.chats.size === 0 &&
      Handover.coming.size === 0 &&
      Handover.aways.size === 0
    ) {
      Handover.leave()
    }
  }

  // ends once no request is under way, to it or from it (a model's answer
  // read on: Agent.READING), and all told to other processes is out (an
  // exit drops what a socket still holds: a call's end; on macOS all past
  // 8 KB); Bun's server.stop() promise would
  // say so of the first, but never resolves once a WebSocket was open
  // (Bun 1.3.14), so the counts are read again each LEAVE ms
  export function leave(): void {
    if (Main.server.pendingRequests === 0 && READING.n === 0) {
      Promise.all(
        [...Handover.peers].map(
          (peer) => new Promise<void>((ok) => peer.end(ok))
        )
      ).then(() => process.exit(0))
      return
    }
    setTimeout(Handover.leave, LEAVE)
  }

  // a line lost: if calls were fed over it from here, or it was the next
  // one's with chats still given it, that process crashed, and this one
  // ends too (the next start resumes all). Else the calls fed over it end
  // (a call's origin crashed; one its relay still passes on ends as that
  // says); the one before
  // frees what waits on it, and this one ends as it was to (Handover.leave)
  export function lost(peer: Peer): void {
    Handover.peers.delete(peer)
    Handover.links.forEach(
      (link, at) => link === peer && Handover.links.delete(at)
    )
    const fed = [...Handover.aways.values()].some((away) => away.link === peer)
    if (
      fed ||
      (peer === Handover.next &&
        (Chat.chats.size > 0 || Handover.coming.size > 0))
    ) {
      process.exit(1)
    }
    if (peer === Handover.back) {
      Handover.listed.resolve()
      Handover.coming.forEach((c) => c.resolve())
      Handover.coming.clear()
    }
    for (const [ref, feed] of peer.feeds) {
      const gate = Handover.gates.get(ref)
      if (gate?.origin === peer) {
        gate.lost = true
        continue
      }
      gate?.origin.feeds.delete(ref)
      Handover.gates.delete(ref)
      feed.end(AskAI.end(ENDED))
    }
    Handover.done()
  }

  // a request for a chat this process gave away, sent where it went
  // (the only one on this port since)
  export function pass(req: Request): Promise<Response> {
    const url = new URL(req.url)
    return fetch("http://127.0.0.1:" + Main.port + url.pathname + url.search, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual"
    })
  }

  // once the chat of `user` the worker before gives is here
  export async function here(user: string): Promise<void> {
    await Handover.listed.promise
    await Handover.coming.get(user)?.promise
  }

  // once all it gives are
  export async function arrived(): Promise<void> {
    await Handover.listed.promise
    await Promise.all([...Handover.coming.values()].map((c) => c.promise))
  }
}
