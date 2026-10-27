// Main
// ====
// The server process: its supervisor, its workers, its sockets.

import * as fs from "node:fs"
import * as net from "node:net"
import {Cloud} from "../cloud.ts"
import {Memory} from "../memory.ts"
import {Providers} from "../../ai/provider.ts"
import {Tools} from "../tools.ts"
import {FRAME, MOVE, PING, QUIT, TICK, WIRE} from "../../view/view.ts"
import * as config from "../../config.ts"
import {
  type Sock,
  type Limit,
  LOCK,
  RETRY,
  HAND,
  BUFFER,
  USERS,
  UNIT,
  FLOOD,
  NETS,
  FETCHES,
  local_request
} from "./shared.ts"
import {Chat} from "./chat.ts"
import {Handover} from "./handover.ts"
import {Http} from "./http.ts"
import {Views} from "./views.ts"
import {noop} from "../../util/noop.ts"

export namespace Main {
  // whether the supervisor ends; its workers, which this is; mails the
  // supervisor sends for it, by id, awaiting answers
  export let leaving = false
  export let count = 1
  export let index = 0

  // a worker: its port and server
  export let port = 0
  export let server: Bun.Server<Sock["data"]>
  // the sockets open here, by user (SOCKETS; Bun opens one inside
  // server.upgrade, so none is opened past it)
  export const sockets = new Map<string, number>()

  // a unix socket one process at a time listens on: one a crash left
  // refuses connections and is taken; one held is waited on
  export async function lock(): Promise<void> {
    fs.mkdirSync(config.DIR, {recursive: true})
    for (;;) {
      try {
        Bun.listen({unix: LOCK, socket: {data: noop}})
        return
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") {
          throw err
        }
      }
      const live = await new Promise<boolean>((done) => {
        const sock = net.connect(LOCK)
        sock.on("connect", () => sock.on("close", () => done(true)))
        sock.on("error", () => done(false))
      })
      if (!live) {
        fs.rmSync(LOCK, {force: true})
      }
    }
  }

  // work one user or peer asks (a socket opened or closed, a chat woken,
  // a message of the process before or after): one that throws (a chat
  // that fails to load or show) fails alone, logged, then `fail`, never
  // the worker, which serves other users too, nor the work that came
  // with it (a view's message fails alone too: Views.answer)
  export function event(
    what: string,
    run: () => void,
    fail: () => void = noop
  ): void {
    try {
      run()
    } catch (err: any) {
      console.error(`kazuki: ${what} failed: ${err?.stack ?? err}`)
      fail()
    }
  }

  // whether `key` may spend n more of its limit; one refused spends
  // nothing
  export function spend(limit: Limit, key: string, n = 1): boolean {
    const now = performance.now()
    const q = limit.keys.get(key) ?? {n: limit.most, at: now}
    q.n = Math.min(limit.most, q.n + ((now - q.at) * limit.rate) / 1000)
    q.at = now
    limit.keys.set(key, q)
    if (q.n < n) {
      return false
    }
    q.n -= n
    return true
  }

  // a key whose quota grew full again is as one never seen: dropped, so
  // a limit holds only the keys near it, not every one it ever saw
  export function forget(limit: Limit): void {
    const full = (limit.most / limit.rate) * 1000
    setInterval(
      () =>
        limit.keys.forEach(
          (q, key) => performance.now() - q.at > full && limit.keys.delete(key)
        ),
      full
    )
  }

  // a user's sockets here, n more (n < 0: fewer); none: dropped
  export function opened(user: string, n: number): void {
    const open = (Main.sockets.get(user) ?? 0) + n
    if (open === 0) {
      Main.sockets.delete(user)
    } else {
      Main.sockets.set(user, open)
    }
  }

  // the worker of a user (signed out: of a token)
  export function shard(key: string): number {
    return Bun.hash.crc32(key) % Main.count
  }

  // a worker, alone or of a supervisor (whose word, over IPC, wakes a
  // terminal signed in elsewhere, and answers a mail it sent): it takes
  // the chats of the one it follows, if any, then serves beside it on
  // the same port
  export async function start(port: number): Promise<void> {
    const send = process.send?.bind(process)
    const change = (user: string) => {
      const chat = Chat.chats.get(user)
      if (chat !== undefined) {
        Views.change(chat)
      }
    }
    const hand = HAND + Main.index
    Main.port = port
    Chat.cloud = Cloud.open(change)
    Handover.back = await Handover.dial(hand)
    if (Handover.back === null) {
      Handover.listed.resolve()
      Chat.wake()
    }
    Tools.coming(Handover.arrived())
    Main.forget(USERS)
    process.on("disconnect", () => process.exit(0))
    process.on("unhandledRejection", Main.unowned)
    Main.server = Bun.serve<Sock["data"]>({
      port,
      hostname: "127.0.0.1",
      reusePort: true,
      idleTimeout: 0,
      maxRequestBodySize: Number.POSITIVE_INFINITY,
      fetch: Http.reply,
      websocket: {
        maxPayloadLength: FRAME,
        backpressureLimit: BUFFER,
        closeOnBackpressureLimit: true,
        idleTimeout: PING / 1000,
        open(ws: Sock) {
          Main.opened(ws.data.user.id, 1)
          Main.event(
            `a socket of user ${ws.data.user.id}`,
            () => {
              if (ws.data.wire !== String(WIRE)) {
                ws.send(
                  JSON.stringify({
                    $: "error",
                    text: "This page or Kazuki is older than the server: reload or reopen it (`kazuki update` for the latest)."
                  })
                )
                return
              }
              const chat = Chat.open(ws.data.user)
              if (chat === null) {
                ws.close(MOVE)
              } else {
                Views.join(chat, ws)
                // what the config set but lost, each time a view opens
                Providers.picks().lost.forEach((text) =>
                  Views.send(ws, {$: "note", text})
                )
              }
            },
            () => ws.close(1011)
          )
        },
        message(ws: Sock, data) {
          const chat = Chat.chats.get(ws.data.user.id)
          if (chat === undefined || !chat.socks.has(ws)) {
            return
          }
          if (Main.spend(USERS, chat.acct.user, 1 + data.length / UNIT)) {
            Views.answer(chat, ws, String(data))
          } else {
            ws.close(FLOOD)
          }
        },
        close(ws: Sock, code) {
          Main.opened(ws.data.user.id, -1)
          Main.event(`a socket of user ${ws.data.user.id}`, () => {
            const chat = Chat.chats.get(ws.data.user.id)
            if (chat !== undefined) {
              Views.leave(chat, ws, code === QUIT)
            }
          })
        }
      }
    })
    setInterval(() => {
      for (const chat of Chat.chats.values()) {
        chat.socks.forEach((sock) => sock.send(TICK))
      }
    }, PING / 2)
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(sig, () => process.exit(0))
    }
    process.on("exit", () => {
      fs.rmSync(Handover.addr, {force: true})
      for (const chat of Chat.chats.values()) {
        Chat.stop(chat, null)
        Memory.stop(chat.mem)
      }
    })
    console.log(
      "kazuki: users in " +
        config.DIR +
        "/users, worker " +
        Main.index +
        " of " +
        Main.count +
        " on 127.0.0.1:" +
        port
    )
    send?.({$: "ready"})
    Handover.back?.send({$: "go", tools: Tools.base()})
    Handover.listen(hand)
  }

  // a failure no owner took: every background promise has one that ends
  // it (a chat's note, a log line), so this is a bug, logged, never the
  // end of the worker and every chat it holds
  export function unowned(err: unknown): void {
    console.error(
      `kazuki: a failure no one owned: ${(err as any)?.stack ?? err}`
    )
  }

  // the workers' supervisor (run: what starts one, on port+1+k,
  // KAZUKI_WORKER=k): holds the lock, starts again a worker that dies,
  // answers each request with its worker's address (`x-kazuki-worker`:
  // README; past its network's limit, NETS, 429). A deploy (SIGHUP) starts
  // each worker anew,
  // which takes the chats of the one before (Main.start); one that fails
  // to start leaves that one serving. Its own code changes only on a
  // restart
  export function supervise(port: number, run: string[]): void {
    const cloud = Cloud.open(noop)
    const workers: Bun.Subprocess[] = []
    const all = new Set<Bun.Subprocess>()
    const hear = (k: number, proc: Bun.Subprocess, msg: any) => {
      switch (msg.$) {
        case "ready": {
          workers[k] = proc
          return
        }
      }
    }
    const start = (k: number) => {
      const env = {
        ...config.config_env(),
        KAZUKI_WORKER: String(k),
        BUN_CONFIG_MAX_HTTP_REQUESTS: String(FETCHES)
      }
      const ipc = (msg: any, proc: Bun.Subprocess) => hear(k, proc, msg)
      const proc = Bun.spawn([...run, String(port + 1 + k)], {
        env,
        ipc,
        stdio: ["ignore", "inherit", "inherit"]
      })
      all.add(proc)
      proc.exited.then((code) => {
        all.delete(proc)
        // again, unless slot k runs one now (a deploy's, ready meanwhile)
        Main.died(
          k,
          code,
          workers[k],
          proc,
          () => Main.runs(workers[k]) || start(k)
        )
      })
    }
    Array.from({length: config.WORKERS}, (_, k) => start(k))
    Main.forget(NETS)
    Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: (req) => {
        if (!local_request(req)) {
          return new Response("loopback and same-origin requests only", {
            status: 403
          })
        }
        if (!Main.spend(NETS, Cloud.net(Cloud.ip(req) ?? ""))) {
          return new Response("too many requests", {status: 429})
        }
        const k = Main.shard(Cloud.who(cloud, req).id)
        return new Response(null, {
          headers: {"x-kazuki-worker": `127.0.0.1:${port + 1 + k}`}
        })
      }
    })
    const stop = () => {
      Main.leaving = true
      all.forEach((w) => w.kill())
      Promise.all([...all].map((w) => w.exited)).then(() => process.exit(0))
    }
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, stop)
    }
    process.on("SIGHUP", () => workers.forEach((_, k) => start(k)))
    console.log(
      "kazuki: " +
        config.WORKERS +
        " workers on 127.0.0.1:" +
        (port + 1) +
        "-" +
        (port + config.WORKERS) +
        ", routes on " +
        port
    )
  }

  // whether a worker process runs
  export function runs(proc: Bun.Subprocess | undefined): boolean {
    return (
      proc !== undefined && proc.exitCode === null && proc.signalCode === null
    )
  }

  // a worker ended (`now`: worker k's, the last that started): as the
  // server ends, nothing; one after a deploy (another is now, and runs)
  // too; worker k's again; one started in place of a dead one, again
  // after a pause (it fails until what stopped it is fixed: a provider
  // connected); one that never started (none is), the server ends
  export function died(
    k: number,
    code: number | null,
    now: Bun.Subprocess | undefined,
    proc: Bun.Subprocess,
    again: () => void
  ): void {
    if (code !== 0) {
      console.error(`kazuki: worker ${k} ended (${code})`)
    }
    if (Main.leaving || (now !== proc && Main.runs(now))) {
      return
    }
    if (now === undefined) {
      process.exit(1)
    }
    if (now === proc) {
      again()
    } else {
      setTimeout(() => Main.leaving || again(), RETRY)
    }
  }
}
