// Chat
// ====
// A user's chat: its turns, restart and stop.

import * as fs from "node:fs"
import {AskAI, type Call, type Event, type Kind} from "../../ai/ask-ai.ts"
import {clip_pages} from "../../util/clip.ts"
import {Cloud, type Account, type User} from "../cloud.ts"
import {Memory, type Share} from "../memory.ts"
import {OpenAI} from "../../ai/openai.ts"
import {Pick} from "../../ai/pick.ts"
import {Providers} from "../../ai/provider.ts"
import {live_push} from "../../ai/live.ts"
import {MASTER, SEARCHES, Tools, type Agent, type Live} from "../tools.ts"
import {IMAGES, TURN, type Done} from "../../view/view.ts"
import {answer_json} from "../../view/link.ts"
import * as config from "../../config.ts"
import {Err, Ok} from "../../util/result.ts"
import {
  type Sock,
  type Body,
  type Msg,
  type Eye,
  type Check,
  type Batch,
  type Moved,
  type Peer,
  LOST,
  HEAD,
  GOAL,
  GOAL_ASK,
  GOAL_NO,
  BATCH,
  READ,
  HELLO,
  HELLO_LINE,
  OPEN_PROMPT
} from "./shared.ts"
import {Handover} from "./handover.ts"
import {Ingest} from "./ingest.ts"
import {Move} from "./move.ts"
import {Views} from "./views.ts"
import {Main} from "./main.ts"
import {noop} from "../../util/noop.ts"

// a chat: acts being done (Views.apply); posts: requests and acts being
// taken, its start till what it resumed runs, and the command after a
// turn; model: what the turn's call runs on, as picked when it began (a
// /model since picks the next call's); asked: a request out, nothing
// back; open: tool calls without results; check: the turn's goal check
// running (Chat.check); sent, wait: messages given and waiting; ending:
// what to do once at rest as it ends (all: nothing runs) or moves (no
// post runs); writes, held: the posts logging, one after another, and
// the logging held meanwhile (null: none)
export type Chat = {
  acct: Account
  mem: Memory
  tools: Tools
  pick: Pick
  socks: Set<Sock>
  acts: Map<string, Promise<Done>>
  busy: boolean
  posts: number
  call: Call | null
  model: string
  check: Check<Call> | null
  asked: boolean
  open: number
  sent: Msg[]
  wait: Msg[]
  halt: AbortController
  live: Live[]
  calls: Record<string, string> // its tool calls awaiting their results, by id (Chat.on)
  eye: Eye
  after: Promise<void>
  batch: Batch | null
  ending: {all: boolean; then: () => void} | null
  writes: Promise<unknown>
  held: Array<() => void> | null
}

// a chat as it moves to another process (Move.move): its user (an id:
// a chat moved is never new, so no hello needs their name, and they may
// have signed out since), its turn (its call and goal check's by their
// refs, Handover.away), the tools' part, its summaries running

export namespace Chat {
  // the accounts (set at start); the chats loaded, by user
  export let cloud: Cloud
  export const chats = new Map<string, Chat>()

  // One moving here takes what ran (`moved`); none opens as this process
  // gives its chats away (null). A chat is kept only once open whole, so
  // one that fails to (throws) is never left half open
  export function open(
    user: User,
    moved: Moved | null = null,
    peer: Peer | null = null
  ): Chat | null {
    const cloud = Chat.cloud
    const old = Chat.chats.get(user.id)
    if (old !== undefined || (Handover.given && moved === null)) {
      return old ?? null
    }
    const acct = {cloud, user: user.id}
    const dir = `${config.DIR}/users/${user.id}`
    const mem = Memory.load(
      dir,
      () => Chat.share(chat),
      (id, ans) => Cloud.act_put(acct, id, ans)
    )
    const tools = Tools.serve(
      mem,
      {
        push: (agent, kind, text) => Chat.push(chat, agent, kind, text),
        on: (agent, ev) => Chat.on(chat, agent, ev),
        report: (agent, text, stopped) =>
          Chat.report(chat, agent, text, stopped),
        change: () => Views.change(chat),
        pick: () => chat.pick,
        halt: () => chat.halt.signal
      },
      moved?.tools.key
    )
    const pick = Pick.load(mem.pick, Providers.offer(), Providers.picks().pick)
    const chat: Chat = {
      acct,
      mem,
      tools,
      pick,
      socks: new Set(),
      acts: new Map(),
      busy: false,
      posts: 1,
      call: null,
      model: "",
      check: null,
      asked: false,
      open: 0,
      sent: [],
      wait: [],
      halt: new AbortController(),
      live: [],
      calls: {},
      eye: {parts: [], from: 0},
      after: Promise.resolve(),
      batch: null,
      ending: null,
      writes: Promise.resolve(),
      held: null
    }
    // a saved pick not offered gave way: told once
    const saved = mem.pick === null ? null : Pick.label(mem.pick as Pick)
    if (saved !== null && saved !== Pick.label(pick)) {
      mem.pick = pick
      Memory.save(mem)
      Chat.note(
        chat,
        saved +
          " isn't offered here, so the chat now runs on " +
          Pick.label(pick) +
          "."
      )
    }
    if (mem.count === 0) {
      Memory.push(mem, [
        {kind: "unii", text: HELLO, line: HELLO_LINE},
        {kind: "unii", text: OPEN_PROMPT}
      ])
    }
    chat.eye = Views.eye(mem, Memory.turn(mem))
    mem.made = (l, i) => Ingest.made(chat, l, i)
    mem.wait.add(() => Ingest.progress(chat))
    mem.wait.add(() => Chat.free(chat))
    const work = moved === null ? mem.work : []
    chat.batch = Ingest.resumed(chat)
    if (moved !== null) {
      Move.arrive(chat, moved, peer!)
    }
    Chat.chats.set(user.id, chat)
    // a microtask on: the caller has the chat before its summaries start
    Promise.resolve()
      .then(async () => {
        Memory.pump(mem)
        Ingest.progress(chat)
        await Chat.resume(chat, work)
      })
      .finally(() => {
        chat.posts -= 1
        Views.change(chat)
      })
      .catch((err) =>
        console.error(`chat ${acct.user}: open: ${err?.message ?? err}`)
      )
    return chat
  }

  // the chat's pick, if offered, else the default the providers connected
  // now make, told (one whose provider disconnected while the server ran
  // gives way here, as a turn starts); with none connected it stays, its
  // call saying so. What the config set and lost since last told, every
  // open view is told too
  export function repick(chat: Chat): void {
    if (Providers.offer().length === 0) {
      return
    }
    const picks = Providers.picks()
    Chat.lost(picks.lost)
    const pick = Pick.load(chat.pick, Providers.offer(), picks.pick)
    const was = Pick.label(chat.pick)
    if (was === Pick.label(pick)) {
      return
    }
    chat.mem.pick = pick
    chat.pick = pick
    Memory.save(chat.mem)
    Chat.note(
      chat,
      was +
        " isn't offered here, so the chat now runs on " +
        Pick.label(pick) +
        "."
    )
    Views.change(chat)
  }

  // what the config lost, each new one told to every open view (each
  // view that opens is told all: Main's socket open)
  export function lost(now: string[]): void {
    const told = LOST.told
    LOST.told = now
    now
      .filter((text) => !told.includes(text))
      .forEach((text) =>
        Chat.chats.forEach((chat) => Views.all(chat, {$: "note", text}))
      )
  }

  // what every call of the chat starts with, a summary's too: its system
  // prompt. A summary gets no tools: one it called, ours or the API's
  // own (web search brings code execution), sent its whole input again
  export function share(chat: Chat): Share {
    const system = Tools.system(MASTER)
    return {...Providers.ask(chat.pick), system, searches: 0, server: ""}
  }

  // at rest (nothing runs): lets go of a chat nobody views; one ending
  // or moving does that once at its rest (Chat.ending), and one ended or
  // moved never
  export function free(chat: Chat): void {
    const acct = chat.acct
    const ending = chat.ending
    if (
      ending !== null &&
      chat.posts === 0 &&
      (!ending.all || Chat.idle(chat))
    ) {
      chat.ending = null
      ending.then()
    }
    if (
      ending !== null ||
      !Chat.idle(chat) ||
      Chat.chats.get(acct.user) !== chat
    ) {
      return
    }
    if (chat.socks.size === 0) {
      Tools.close(chat.tools)
      Memory.stop(chat.mem)
      Chat.chats.delete(acct.user)
    }
  }

  // no turn, post, agent or summary runs
  export function idle(chat: Chat): boolean {
    return (
      !chat.busy &&
      chat.posts === 0 &&
      Tools.working(chat.tools).length === 0 &&
      chat.mem.busy.size === 0
    )
  }

  // stops a chat for good; done at rest, its work logged where it was cut
  export function end(chat: Chat): Promise<void> {
    Chat.chats.delete(chat.acct.user)
    chat.socks.forEach((sock) => sock.close())
    Chat.stop(chat, null)
    Memory.stop(chat.mem)
    return new Promise((done) => {
      const then = () => {
        Tools.close(chat.tools)
        done()
      }
      chat.ending = {all: true, then}
      Chat.free(chat)
    })
  }

  // a message (its body: its images, sizes given, then its text), logged
  // and taken
  export async function say(
    chat: Chat,
    id: string,
    sizes: number[],
    body: Body
  ): Promise<Done> {
    const images: string[] = []
    let at = 0
    for (const size of sizes) {
      const name = await Memory.image_add(
        chat.mem,
        await Chat.read(body, at, size)
      )
      if (name === null) {
        return new Err(new Error(IMAGES))
      }
      images.push(name)
      at += size
    }
    await Chat.writing(chat, async () =>
      Chat.take(chat, await Chat.text(chat, body, at, images, id))
    )
    return new Ok({})
  }

  // up to n bytes of a body, from byte `at`
  export async function read(
    body: Body,
    at: number,
    n: number
  ): Promise<Buffer<ArrayBuffer>> {
    const buf = Buffer.alloc(n)
    const got = await body.fh.read(buf, 0, n, at)
    return buf.subarray(0, got.bytesRead)
  }

  // a body's text from byte `at`, logged as the user's message, a read
  // at a time, the last with the images and the act's record
  export async function text(
    chat: Chat,
    body: Body,
    at: number,
    images: string[],
    act: string
  ): Promise<Msg> {
    const id = chat.mem.count
    for await (const [pages, more] of Chat.pieces(body, at, clip_pages)) {
      Chat.push(
        chat,
        null,
        "user",
        pages.join(""),
        more ? [] : images,
        more,
        more ? undefined : act
      )
    }
    return {id, end: chat.mem.count}
  }

  // a post's logging, after the chat's earlier ones, holding its other
  // logging (Chat.hold) till it ends, so a long post's pages stay together
  export function writing<T>(chat: Chat, write: () => Promise<T>): Promise<T> {
    const run = chat.writes.then(async () => {
      chat.held = []
      try {
        return await write()
      } finally {
        const held = chat.held ?? []
        chat.held = null
        chat.mem.open = 0
        held.forEach((step) => step())
      }
    })
    chat.writes = run.catch(noop)
    return run
  }

  // a step that logs to the chat: now, or once the post logging ends
  export function hold(chat: Chat, step: () => void): void {
    if (chat.held === null) {
      step()
    } else {
      chat.held.push(step)
    }
  }

  // a body's text from byte `at`, cut in pieces a READ at a time, and
  // whether more come; none over READ
  export async function* pieces(
    body: Body,
    start: number,
    cut: (text: string) => string[]
  ): AsyncGenerator<[string[], boolean]> {
    let at = start
    const dec = new TextDecoder()
    let rest = ""
    do {
      const buf = await Chat.read(body, at, READ)
      at += buf.length
      const all = cut(rest + dec.decode(buf, {stream: at < body.size}))
      rest = at < body.size ? all.pop()! : ""
      if (rest.length > READ) {
        throw new Error(`A line over ${READ} characters: no import sends it.`)
      }
      yield [all, at < body.size]
    } while (at < body.size)
  }

  // a recording's words, logged as the act's answer
  export async function voice(
    chat: Chat,
    id: string,
    type: string,
    body: Body
  ): Promise<Done> {
    const got = await OpenAI.transcribe(
      new Blob([await Chat.read(body, 0, body.size)], {type})
    )
    if (!got.ok) {
      return new Err(got.error())
    }
    const said = new Ok({text: got.value().text})
    Views.mark(chat, id, {ans: answer_json(said)})
    return said
  }

  // a message logged: to the running call if whole beside its view, else
  // to the next
  export function take(chat: Chat, msg: Msg): void {
    const mem = chat.mem
    if (chat.call !== null && Memory.whole(mem, msg.id) === msg.id) {
      chat.sent.push(msg)
      chat.call.send(Memory.say(mem, msg.id, msg.end))
      return
    }
    chat.wait.push(msg)
    if (!chat.busy) {
      Chat.turn(chat)
    }
  }

  // first: the end of the call running (its chat moved here)
  export async function turn(
    chat: Chat,
    first: Promise<boolean> | null = null
  ): Promise<void> {
    chat.busy = true
    try {
      let go = first === null || (await first)
      while (go && chat.wait.length > 0) {
        go = await Chat.call(chat)
      }
    } catch (err: any) {
      Chat.failed(chat, String(err?.message ?? err))
    } finally {
      const why: string | null = chat.halt.signal.aborted
        ? chat.halt.signal.reason
        : null
      if (why !== null) {
        Chat.note(chat, why)
      }
      chat.call = null
      chat.sent = []
      chat.wait = []
      chat.busy = false
      Chat.live(chat, null, [])
      Chat.after(chat)
      Views.change(chat)
    }
  }

  // where a call's messages go whole from (a message meanwhile may move it)
  export function from(chat: Chat): number {
    return Memory.whole(chat.mem, chat.wait[0].id)
  }

  // false: the turn ends
  export async function call(chat: Chat): Promise<boolean> {
    const mem = chat.mem
    Chat.repick(chat)
    const halt = new AbortController()
    chat.halt = halt
    Views.change(chat)
    let from = -1
    while (from !== Chat.from(chat)) {
      from = Chat.from(chat)
      const why = await Memory.settle(mem, from, halt.signal)
      if (why !== null) {
        return false
      }
    }
    const msgs = chat.wait.splice(0)
    chat.sent = msgs
    const says = msgs
      .filter((m) => m.end > from)
      .map((m) => Memory.say(mem, Math.max(m.id, from), m.end))
    const view = Memory.view(mem, from)
    const text = says.map((say) => say.text).join("\n\n")
    const imgs = says.flatMap((say) => say.imgs)
    const server = Tools.at(chat.tools, "main")
    chat.eye = Views.eye(mem, from)
    chat.socks.forEach((sock) => Views.show(chat, sock))
    const blocks = [
      ...view,
      Tools.devices(chat.tools),
      Tools.at_work(chat.tools),
      {text: HEAD + text, mark: true}
    ]
    const ask = {...Chat.share(chat), searches: SEARCHES, server, blocks, imgs}
    chat.model = chat.pick.model
    chat.asked = true
    chat.open = 0
    const call = AskAI.ask(ask, (ev) => Chat.on(chat, null, ev))
    chat.call = call
    Views.change(chat)
    return Chat.ended(chat, call, halt)
  }

  // the turn's call ends; false: the turn ends
  export async function ended(
    chat: Chat,
    call: Call,
    halt: AbortController
  ): Promise<boolean> {
    const end = await call.done
    chat.call = null
    Chat.unanswered(chat, null)
    Chat.live(chat, null, [])
    chat.wait.unshift(...chat.sent.slice(chat.sent.length - end.left.length))
    if (!(end.ok || halt.signal.aborted)) {
      Chat.failed(chat, end.text)
    }
    if (end.note) {
      Views.all(chat, {$: "note", text: end.note})
    }
    const goal = chat.mem.goal
    if (
      end.ok &&
      !halt.signal.aborted &&
      chat.wait.length === 0 &&
      goal !== null
    ) {
      return Chat.checked(chat, Chat.check(chat, goal), halt)
    }
    return !halt.signal.aborted
  }

  // the user's goal (/goal), asked of the chat's model, without tools, on
  // the chat as it is now
  export function check(chat: Chat, goal: string): Check<Call> {
    const mem = chat.mem
    const at = Memory.whole(mem, 0)
    const tail = Array.from({length: mem.count - at}, (_, k) => at + k).map(
      (i) => {
        const msg = Memory.message(mem, i)!
        return `${Memory.line({l: 0, i}, `${msg.kind}: ${msg.text}`)}\n`
      }
    )
    const blocks = [
      ...Memory.view(mem, at),
      {text: tail.join("") + GOAL_ASK + goal, mark: true}
    ]
    return {
      call: AskAI.ask({...Chat.share(chat), system: GOAL, blocks}, noop),
      goal
    }
  }

  // a goal check's answer, as the turn's call's is, read where the chat
  // is (its call moves with it: Move.move): unmet (any answer but yes),
  // the user's nudge goes to the turn as their message; met, the goal
  // ends. A check that fails, a stop, a message or a /halt meanwhile end
  // it with no nudge, so the turn ends; false: it ends
  export async function checked(
    chat: Chat,
    check: Check<Call>,
    halt: AbortController
  ): Promise<boolean> {
    chat.check = check
    const {call, goal} = check
    halt.signal.addEventListener("abort", () => call.stop(), {once: true})
    const end = await call.done
    const mem = chat.mem
    const on =
      !halt.signal.aborted && mem.goal === goal && chat.wait.length === 0
    chat.check = null
    if (on && !end.ok) {
      Chat.note(
        chat,
        "No goal check: " +
          end.text.replace(/\.$/, "") +
          ". The goal stays; /halt drops it."
      )
    } else if (on && /^\W*yes\b/i.test(end.text)) {
      mem.goal = null
      Memory.save(mem)
      Chat.note(chat, "Goal met.")
    } else if (on) {
      await Chat.writing(chat, async () =>
        Chat.take(chat, Chat.push(chat, null, "user", GOAL_NO))
      )
    }
    return !halt.signal.aborted
  }

  // a failed turn's why, as a note
  export function failed(chat: Chat, why: string): void {
    Chat.note(
      chat,
      `No reply: ${why.replace(/\.$/, "")}. Send a message to try again.`
    )
  }

  // a note in the chat, why work ended as it did
  export function note(chat: Chat, text: string): void {
    Chat.hold(chat, () => Chat.push(chat, null, "note", text))
  }

  // to the chat (in pages), or an agent's log; each told to every view
  export function push(
    chat: Chat,
    agent: Agent | null,
    kind: Kind,
    text: string,
    images: string[] = [],
    more = false,
    act?: string
  ): Msg {
    if (agent !== null) {
      const id = Memory.agent_push(chat.mem, agent.name, kind, text)
      Views.all(chat, {$: "entry", agent: agent.name, id, kind, text})
      return {id, end: id + 1}
    }
    const roots = Memory.push(chat.mem, [{kind, text, images, more, act}])
    for (const {i, kind, text, date, images} of roots) {
      Views.all(chat, {$: "entry", id: i, kind, text, date, images})
    }
    return {id: roots[0].i, end: chat.mem.count}
  }

  // a message the call took was logged as it came
  export function on(chat: Chat, agent: Agent | null, ev: Event): void {
    const at = agent ?? chat
    const name = agent?.name
    if (agent === null) {
      Chat.asks(chat, ev)
    }
    if (ev.$ === "Delta") {
      live_push(at.live, ev.kind, ev.text, ev.fresh)
      Views.all(chat, {
        $: "delta",
        agent: name,
        kind: ev.kind,
        text: ev.text,
        fresh: ev.fresh
      })
      return
    }
    if (ev.kind === "tool" && ev.of !== undefined) {
      at.calls[ev.of] = ev.text
    } else if (ev.kind === "mind") {
      Views.all(chat, {$: "entry", agent: name, kind: ev.kind, text: ev.text})
    } else if (ev.kind !== "user") {
      const call = ev.of === undefined ? undefined : at.calls[ev.of]
      delete at.calls[ev.of ?? ""]
      Chat.hold(chat, () => {
        if (call !== undefined) {
          Chat.push(chat, agent, "tool", call)
        }
        Chat.push(chat, agent, ev.kind, ev.text)
      })
    }
    Chat.live(chat, agent, Chat.waiting(at))
  }

  // what streams once an entry came: the tool calls awaiting their
  // results, as they will be logged; what was drawn never vanishes
  // before it is printed
  export function waiting(at: {calls: Record<string, string>}): Live[] {
    return Object.values(at.calls).map((text) => ({kind: "tool", text}))
  }

  // a call's tool calls left without a result (it was stopped), logged
  // as they are, once it ends
  export function unanswered(chat: Chat, agent: Agent | null): void {
    const at = agent ?? chat
    const calls = Object.values(at.calls)
    at.calls = {}
    Chat.hold(chat, () =>
      calls.forEach((call) => Chat.push(chat, agent, "tool", call))
    )
    Chat.live(chat, agent, [])
  }

  // the model is asked again once handed all it waits for, until its
  // answer starts
  export function asks(chat: Chat, ev: Event): void {
    const kind = ev.$ === "Entry" ? ev.kind : ""
    const step = kind === "tool" ? 1 : kind === "echo" ? -1 : 0
    chat.open = ev.$ === "Delta" ? 0 : Math.max(0, chat.open + step)
    const asked = (kind === "echo" || kind === "user") && chat.open === 0
    if (asked !== chat.asked) {
      chat.asked = asked
      Views.change(chat)
    }
  }

  // what streams for the chat (agent: null) or an agent, set and told
  export function live(chat: Chat, agent: Agent | null, live: Live[]): void {
    ;(agent ?? chat).live = live
    Views.all(chat, {$: "live", agent: agent?.name, live})
  }

  // an agent's report, once it ends: a turn of its own, unless stopped;
  // none once its chat ended (the next start resumes it).
  // It is taken as a post is, so the chat never rests between logging it
  // and its turn
  export function report(
    chat: Chat,
    agent: Agent,
    text: string,
    stopped: boolean
  ): void {
    Chat.unanswered(chat, agent)
    Chat.live(chat, agent, [])
    Chat.hold(chat, () => {
      chat.posts += 1
      const msg =
        Chat.chats.get(chat.acct.user) === chat
          ? Chat.push(chat, null, "work", text)
          : null
      if (msg !== null && !stopped) {
        Chat.take(chat, msg)
      }
      chat.posts -= 1
      Views.change(chat)
      Chat.free(chat)
    })
  }

  // config.AFTER, a shell command, after each turn
  export function after(chat: Chat): void {
    if (!config.AFTER) {
      return
    }
    chat.posts += 1
    chat.after = chat.after
      .then(async () => {
        const proc = Bun.spawn(["/bin/sh", "-c", config.AFTER], {
          stdout: "ignore",
          stderr: "pipe"
        })
        const err = await new Response(proc.stderr).text()
        if ((await proc.exited) !== 0) {
          Views.all(chat, {$: "note", text: `after: ${err.trim()}`})
        }
      })
      .catch((err) => console.error(`after: ${err?.message ?? err}`))
      .finally(() => {
        chat.posts -= 1
        Chat.free(chat)
      })
  }

  // the chats a restart cut at work or importing, opened; one that fails
  // to load is logged and left (its user's page gets the error), never
  // keeping the worker, which serves every other user, from starting
  export function wake(): void {
    const dir = `${config.DIR}/users/`
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const user =
        Main.shard(id) === Main.index ? Cloud.user(Chat.cloud, id) : null
      if (
        user !== null &&
        ((Memory.saved(dir + id)?.work ?? []).length > 0 ||
          fs.existsSync(dir + id + BATCH))
      ) {
        Main.event(`waking the chat of user ${id}`, () => Chat.open(user))
      }
    }
  }

  // the work a restart cut goes on, told so: each agent, and Kazuki's turn
  // by a note (none for a chat ended meanwhile)
  export async function resume(chat: Chat, work: string[]): Promise<void> {
    if (work.length === 0 || Chat.chats.get(chat.acct.user) !== chat) {
      return
    }
    const text =
      "The server restarted, cutting " +
      work.join(", ") +
      "; nothing was lost: go on."
    const msg = Chat.push(chat, null, "note", text)
    await Promise.all(
      work.map((w) =>
        w === TURN ? Chat.take(chat, msg) : Tools.tell(chat.tools, w, text)
      )
    )
  }

  // what runs: Kazuki's turn, the agents at work
  export function running(chat: Chat): string[] {
    return [
      ...(chat.busy ? [TURN] : []),
      ...Tools.working(chat.tools).map((a) => a.name)
    ]
  }

  // Kazuki's turn only, with the spawns and tells it waits on (for the
  // view: Tools.view, on chat.halt); agents go on. why: the note the turn's
  // end logs (Chat.turn), so after the reply the stop cut; null: none
  export function interrupt(chat: Chat, why: string | null): void {
    chat.halt.abort(why)
    chat.call?.stop()
  }

  // all work, agents too; its why noted at the turn's end, or at once if
  // no turn is left to end
  export function stop(chat: Chat, why: string | null): void {
    const turn = chat.busy && !chat.halt.signal.aborted
    Chat.interrupt(chat, turn ? why : null)
    Tools.stop(chat.tools, null)
    if (!turn && why !== null) {
      Chat.note(chat, why)
    }
  }
}
