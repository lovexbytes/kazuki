// Main
// ====
// The server process: its supervisor, its workers, its sockets.

import * as fs from "node:fs";
import * as net from "node:net";
import { READING } from "../../ai/agent.ts";
import { AskAI, type Call, type End, type Event, type Say } from "../../ai/ask-ai.ts";
import { Cloud, type User } from "../cloud.ts";
import { Memory } from "../memory.ts";
import { Providers } from "../../ai/provider.ts";
import { Tools } from "../tools.ts";
import { FRAME, MOVE, PING, QUIT, TICK, WIRE, answer_json } from "../../view/view.ts";
import * as config from "../config.ts";
import { Sock, Moved, Peer, Away, Gate, Limit, LOCK, RETRY, HAND, LEAVE, ENDED, BUFFER, PIECE, USERS, UNIT, FLOOD, SOCKETS, NETS, FETCHES, OWN, local_request, WEB } from "./shared.ts";
import { Chat } from "./chat.ts";
import { Ingest } from "./ingest.ts";
import { Move } from "./move.ts";
import { Views } from "./views.ts";


export namespace Main {

  // whether the supervisor ends; its workers, which this is; mails the
  // supervisor sends for it, by id, awaiting answers
  export let leaving = false;
  export let count   = 1;
  export let index   = 0;

  // a worker: its port and server; the process it took its chats from,
  // its address, and the users whose chats that one has yet to give
  // (Main.here), once it said which; the one it gives its chats to, and
  // whether it does
  export let port    = 0;
  export let server  : Bun.Server<Sock["data"]>;
  export let back    : Peer | null = null;
  export let before  = "";
  export const coming = new Map<string, PromiseWithResolvers<void>>();
  export let listed  = Promise.withResolvers<void>();
  export let next    : Peer | null = null;
  export let given   = false;
  export let onward  = "";
  // the sockets open here, by user (SOCKETS; Bun opens one inside
  // server.upgrade, so none is opened past it)
  export const sockets = new Map<string, number>();

  // this process's address (Main.listen); every line to another, and those
  // it opened to calls' origins, by address; the calls it feeds to where
  // their chats went (Main.away) and those its relays still pass on to it
  // (Main.far), by ref; each call's ref here, if fed from elsewhere
  export let addr    = "";
  export const peers  = new Set<Peer>();
  export const links  = new Map<string, Peer>();
  export const aways  = new Map<string, Away>();
  export const gates  = new Map<string, Gate>();
  export const refs   = new WeakMap<Call, string>();

  // a unix socket one process at a time listens on: one a crash left
  // refuses connections and is taken; one held is waited on
  export async function lock(): Promise<void> {
    fs.mkdirSync(config.DIR, { recursive: true });
    while (true) {
      try {
        Bun.listen({ unix: LOCK, socket: { data() {} } });
        return;
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") {
          throw err;
        }
      }
      const live = await new Promise<boolean>((done) => {
        const sock = net.connect(LOCK);
        sock.on("connect", () => sock.on("close", () => done(true)));
        sock.on("error", () => done(false));
      });
      if (!live) {
        fs.rmSync(LOCK, { force: true });
      }
    }
  }

  // a site's file
  export function file(pathname: string): Response {
    const file = WEB[pathname];
    return file === undefined ? new Response("not found", { status: 404 }) : new Response(Bun.file(file));
  }


  // deletes the local chat, if they typed its name,
  // where their chat is: one the worker before still gives (a deploy) is
  // waited for, so it ends before its files go
  export async function close(req: Request): Promise<Response> {
    const cloud = Chat.cloud;
    const user = Cloud.who(cloud, req);
    const confirm = String((await req.json().catch(() => ({}))).confirm ?? "").trim().toLowerCase();
    if (confirm !== user.name.toLowerCase()) {
      const name = "type \"" + user.name + "\".";
      const error = "Deleting the local chat erases Kazuki's memory for good. To confirm, " + name;
      return Response.json({ error }, { status: 400 });
    }
    await Main.here(user.id);
    const chat = Chat.chats.get(user.id);
    await (chat === undefined ? Promise.resolve() : Chat.end(chat));
    Cloud.close(cloud, user);
    fs.rmSync(config.DIR + "/users/" + user.id, { recursive: true, force: true });
    return new Response(null, { status: 204 });
  }

  // a long answer, sent as made, a PIECE at a time, the event loop
  // running between (Bun sends an async generator as a body; the DOM's
  // types know none)
  export function stream(lines: Iterable<string>): BodyInit {
    async function* pieces(): AsyncGenerator<string> {
      let piece = "";
      for (const line of lines) {
        piece += line;
        if (piece.length >= PIECE) {
          yield piece;
          piece = "";
          await new Promise((ok) => setImmediate(ok));
        }
      }
      yield piece;
    }
    return pieces() as unknown as BodyInit;
  }

  // a page or post of the user's chat (/api/act: an act with a body, its
  // fields in the query; a POST only, since a GET is what another site
  // may send with the user's cookie, by sending their browser here, from
  // a browser that doesn't say where it comes from: Main.http)
  export async function page(chat: Chat, user: User, p: string, req: Request): Promise<Response> {
    const mem = chat.mem;
    switch (p) {
      case "/tree": {
        return new Response(Main.stream(Memory.page(mem)), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      case "/export": {
        const name = "kazuki-memory-" + new Date().toISOString().slice(0, 10) + ".json";
        const json = { "content-type": "application/json", "content-disposition": 'attachment; filename="' + name + '"' };
        return new Response(Main.stream(Memory.dump(mem, await Cloud.data(Chat.cloud, user))), { headers: json });
      }
      case "/api/act": {
        if (req.method !== "POST") {
          return new Response("an act is a POST", { status: 405 });
        }
        if (!Main.spend(USERS, user.id)) {
          return Response.json({ error: "Too many requests: wait a moment." }, { status: 429 });
        }
        const msg = { ...Object.fromEntries(new URL(req.url).searchParams), req };
        const out = answer_json(await Views.apply(chat, msg, ""));
        return Response.json(out, { status: out.status ?? (out.error === undefined ? 200 : 400) });
      }
      case "/api/imported": {
        return Response.json(Ingest.done(chat));
      }
    }
    const file = Memory.image_file(mem, p.slice("/image/".length));
    const keep = { "cache-control": "private, max-age=31536000, immutable" };
    return file === null ? new Response("not found", { status: 404 }) : new Response(Bun.file(file), { headers: keep });
  }

  // a request; one for a chat this process gave away goes there. Another
  // site's page (its browser says so: Sec-Fetch-Site) only links here: it
  // posts nothing, reaches no /api/ and opens no socket, so no site acts
  // for its visitors (sends a message or opens a socket)
  // an answer of a process giving its chats away closes its connection,
  // so no client (Caddy, another worker's Main.pass) keeps one to reuse as
  // the process ends
  export async function reply(req: Request, server: Bun.Server<Sock["data"]>): Promise<Response | undefined> {
    const res = await Main.http(req, server);
    if (res === undefined || !Main.given) {
      return res;
    }
    const headers = new Headers(res.headers);
    headers.set("connection", "close");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  export async function http(req: Request, server: Bun.Server<Sock["data"]>): Promise<Response | undefined> {
    const p = new URL(req.url).pathname;
    const cloud = Chat.cloud;
    if (!local_request(req)) {
      return new Response("loopback and same-origin requests only", { status: 403 });
    }
    const away = /^(cross|same)-site$/.test(req.headers.get("sec-fetch-site") ?? "");
    if (away && (req.method !== "GET" || p.startsWith("/api/") || p === "/ws")) {
      return new Response("not from another site", { status: 403 });
    }
    try {
      const user = Cloud.who(cloud, req);
      if (Main.shard(user.id) !== Main.index) {
        return new Response("this user's worker is another", { status: 421 });
      }
      const api = await Cloud.http(cloud, req);
      if (api !== null) {
        return api;
      }
      if (p === "/api/delete") {
        return await Main.close(req);
      }
      if (!OWN.includes(p) && !p.startsWith("/image/") && !p.startsWith("/api/")) {
        return Main.file(p);
      }
      await Main.here(user.id);
      if (p === "/ws") {
        if ((Main.sockets.get(user.id) ?? 0) >= SOCKETS || !Main.spend(USERS, user.id)) {
          return new Response("too many requests", { status: 429 });
        }
        const q    = new URL(req.url).searchParams;
        const who  = "local";
        const work = q.get("work") ?? "~/.kazuki/work";
        const data = { user, who, tab: q.get("tab") ?? "", wire: q.get("wire"), host: q.get("device"), computer: q.get("computer") === "1", work, device: null, seen: new Set<string>() };
        return server.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const chat = Chat.open(user);
      if (chat === null) {
        return await Main.pass(req);
      }
      chat.posts += 1;
      const res = await Main.page(chat, user, p, req).finally(() => (chat.posts -= 1));
      Chat.free(chat);
      return res;
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // work one user or peer asks (a socket opened or closed, a chat woken,
  // a message of the process before or after): one that throws (a chat
  // that fails to load or show) fails alone, logged, then `fail`, never
  // the worker, which serves other users too, nor the work that came
  // with it (a view's message fails alone too: Views.answer)
  export function event(what: string, run: () => void, fail: () => void = () => {}): void {
    try {
      run();
    } catch (err: any) {
      console.error("kazuki: " + what + " failed: " + (err?.stack ?? err));
      fail();
    }
  }

  // whether `key` may spend n more of its limit; one refused spends
  // nothing
  export function spend(limit: Limit, key: string, n = 1): boolean {
    const now = performance.now();
    const q = limit.keys.get(key) ?? { n: limit.most, at: now };
    q.n = Math.min(limit.most, q.n + ((now - q.at) * limit.rate) / 1000);
    q.at = now;
    limit.keys.set(key, q);
    if (q.n < n) {
      return false;
    }
    q.n -= n;
    return true;
  }

  // a key whose quota grew full again is as one never seen: dropped, so
  // a limit holds only the keys near it, not every one it ever saw
  export function forget(limit: Limit): void {
    const full = (limit.most / limit.rate) * 1000;
    setInterval(() => limit.keys.forEach((q, key) => performance.now() - q.at > full && limit.keys.delete(key)), full);
  }

  // a user's sockets here, n more (n < 0: fewer); none: dropped
  export function opened(user: string, n: number): void {
    const open = (Main.sockets.get(user) ?? 0) + n;
    if (open === 0) {
      Main.sockets.delete(user);
    } else {
      Main.sockets.set(user, open);
    }
  }

  // the worker of a user (signed out: of a token)
  export function shard(key: string): number {
    return Bun.hash.crc32(key) % Main.count;
  }

  // a worker, alone or of a supervisor (whose word, over IPC, wakes a
  // terminal signed in elsewhere, and answers a mail it sent): it takes
  // the chats of the one it follows, if any, then serves beside it on
  // the same port
  export async function start(port: number): Promise<void> {
    const send = process.send?.bind(process);
    const change = (user: string) => {
      const chat = Chat.chats.get(user);
      if (chat !== undefined) {
        Views.change(chat);
      }
    };
    const hand = HAND + Main.index;
    Main.port = port;
    Chat.cloud = Cloud.open(change);
    Main.back = await Main.dial(hand);
    if (Main.back === null) {
      Main.listed.resolve();
      Chat.wake();
    }
    Tools.coming(Main.arrived());
    Main.forget(USERS);
    process.on("disconnect", () => process.exit(0));
    process.on("unhandledRejection", Main.unowned);
    Main.server = Bun.serve<Sock["data"]>({
      port               : port,
      hostname           : "127.0.0.1",
      reusePort          : true,
      idleTimeout        : 0,
      maxRequestBodySize : Infinity,
      fetch              : Main.reply,
      websocket          : {
        maxPayloadLength         : FRAME,
        backpressureLimit        : BUFFER,
        closeOnBackpressureLimit : true,
        idleTimeout              : PING / 1000,
        open(ws: Sock) {
          Main.opened(ws.data.user.id, 1);
          Main.event("a socket of user " + ws.data.user.id, () => {
            if (ws.data.wire !== String(WIRE)) {
              ws.send(JSON.stringify({ $: "error", text: "This page or Kazuki is older than the server: reload or reopen it (`kazuki update` for the latest)." }));
              return;
            }
            const chat = Chat.open(ws.data.user);
            if (chat === null) {
              ws.close(MOVE);
            } else {
              Views.join(chat, ws);
              // what the config set but lost, each time a view opens
              Providers.picks().lost.forEach((text) => Views.send(ws, { $: "note", text }));
            }
          }, () => ws.close(1011));
        },
        message(ws: Sock, data) {
          const chat = Chat.chats.get(ws.data.user.id);
          if (chat === undefined || !chat.socks.has(ws)) {
            return;
          }
          if (Main.spend(USERS, chat.acct.user, 1 + data.length / UNIT)) {
            Views.answer(chat, ws, String(data));
          } else {
            ws.close(FLOOD);
          }
        },
        close(ws: Sock, code) {
          Main.opened(ws.data.user.id, -1);
          Main.event("a socket of user " + ws.data.user.id, () => {
            const chat = Chat.chats.get(ws.data.user.id);
            if (chat !== undefined) {
              Views.leave(chat, ws, code === QUIT);
            }
          });
        },
      },
    });
    setInterval(() => {
      for (const chat of Chat.chats.values()) {
        chat.socks.forEach((sock) => sock.send(TICK));
      }
    }, PING / 2);
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(sig, () => process.exit(0));
    }
    process.on("exit", () => {
      fs.rmSync(Main.addr, { force: true });
      for (const chat of Chat.chats.values()) {
        Chat.stop(chat, null);
        Memory.stop(chat.mem);
      }
    });
    console.log("kazuki: " + config.SITE + ", users in " + config.DIR + "/users, worker " + Main.index + " of " + Main.count + " on 127.0.0.1:" + port);
    send?.({ $: "ready" });
    Main.back?.send({ $: "go", tools: Tools.base() });
    Main.listen(hand);
  }

  // a failure no owner took: every background promise has one that ends
  // it (a chat's note, a log line), so this is a bug, logged, never the
  // end of the worker and every chat it holds
  export function unowned(err: unknown): void {
    console.error("kazuki: a failure no one owned: " + ((err as any)?.stack ?? err));
  }

  // Handover
  // --------
  // Worker k's successor reaches it at HAND + k (which leads to the
  // newest's own address: Main.listen), says go (its tools' URL), then
  // listens for its own (a successor that dies before that leaves this
  // one serving, reachable again). This one stops serving (its watch
  // too), says its address, which chats it holds and which still come to
  // it (a deploy during a deploy: the one before gives a chat only at
  // rest, after a long post), and gives each on as it can (Move.give),
  // those coming once they come. A call goes on in the process that
  // started it, fed straight to its chat's process (Main.away, Main.far),
  // so one that passed calls on ends once their origins feed the next.
  // A process ends once nothing is left to come, run or pass
  // on (Main.done).

  // the worker before this one, if one listens at `hand`
  export function dial(hand: string): Promise<Peer | null> {
    return new Promise((done) => {
      const sock = net.connect(hand);
      sock.once("connect", () => done(Main.peer(sock)));
      sock.once("error", () => done(null));
    });
  }

  // this process's address, `hand` and its pid, which any process may
  // reach (a call's new process: Main.far); once it listens, `hand`
  // leads to it, so the next worker k reaches this one
  export function listen(hand: string): void {
    const temp = hand + ".link";
    Main.addr = hand + "." + process.pid;
    fs.rmSync(Main.addr, { force: true });
    net.createServer((sock) => Main.peer(sock)).listen(Main.addr, () => {
      fs.rmSync(temp, { force: true });
      fs.symlinkSync(Main.addr, temp);
      fs.renameSync(temp, hand);
    });
  }

  // a peer over a socket, a line of JSON a message, each heard alone
  // (Main.event): one that fails (a chat moved here that won't open) is
  // logged, and the rest of the read (the chats moved after it) goes on
  export function peer(sock: net.Socket): Peer {
    const peer: Peer = { send: (msg) => sock.write(JSON.stringify(msg) + "\n"), end: (then) => (sock.destroyed ? then() : sock.end(then)), feeds: new Map() };
    let rest = "";
    Main.peers.add(peer);
    sock.setEncoding("utf8");
    sock.on("data", (data: string) => {
      const lines = (rest + data).split("\n");
      rest = lines.pop()!;
      lines.forEach((line) => Main.event("a message of another worker", () => Main.told(peer, JSON.parse(line))));
    });
    sock.on("error", () => {});
    sock.on("close", () => Main.lost(peer));
    return peer;
  }

  // the process at `addr` (a call's origin: Main.far), by one line
  export function link(addr: string): Peer {
    const known = Main.links.get(addr);
    if (known !== undefined) {
      return known;
    }
    const peer = Main.peer(net.connect(addr));
    Main.links.set(addr, peer);
    return peer;
  }

  // a peer's message; a chat moved here frees its user's requests first,
  // so one that won't open is opened by them anew, as after a restart
  // (Chat.open: it was never kept half open). What a call's origin sends
  // while its relay still passes on is held (Main.far)
  export function told(peer: Peer, msg: any): void {
    const gate = Main.gates.get(msg.call);
    if (gate?.origin === peer) {
      gate.held.push(msg);
      return;
    }
    switch (msg.$) {
      case "go": {
        if (Main.next !== null) {
          return peer.end(() => {});
        }
        Main.next = peer;
        Main.server.stop();
        Main.given = true;
        Main.onward = msg.tools;
        Main.listed.promise.then(() => {
          peer.send({ $: "users", addr: Main.addr, users: [...Chat.chats.keys(), ...Main.coming.keys()] });
          [...Chat.chats.values()].forEach((chat) => Move.give(chat, peer, msg.tools));
          Main.done();
        }).catch((err) => console.error("kazuki: giving the chats failed: " + (err?.stack ?? err)));
        return;
      }
      case "users": {
        Main.before = msg.addr ?? "";
        (msg.users as string[]).forEach((user) => Main.coming.set(user, Promise.withResolvers()));
        Main.listed.resolve();
        return;
      }
      case "chat": {
        const moved: Moved = msg.moved;
        Main.coming.get(moved.user)?.resolve();
        Main.coming.delete(moved.user);
        const chat = Chat.open({ id: moved.user, name: "" }, moved, peer);
        if (chat !== null && Main.given) {
          Move.give(chat, Main.next!, Main.onward);
        }
        Main.done();
        return;
      }
      case "ev": {
        peer.feeds.get(msg.call)?.on(msg.ev);
        return;
      }
      case "end": {
        peer.feeds.get(msg.call)?.end(msg.end);
        peer.feeds.delete(msg.call);
        gate?.origin.feeds.delete(msg.call);
        Main.gates.delete(msg.call);
        return;
      }
      case "take": {
        Tools.went(msg.key, msg.tools);
        const away = Main.aways.get(msg.call);
        if (away !== undefined) {
          away.link.send({ $: "gone", call: msg.call });
          away.link = peer;
        }
        return;
      }
      case "gone": {
        if (gate !== undefined) {
          return Main.open(msg.call, gate);
        }
        peer.feeds.delete(msg.call);
        Main.aways.get(msg.call)?.link.send(msg);
        Main.aways.delete(msg.call);
        Main.done();
        return;
      }
      case "send": {
        Main.aways.get(msg.call)?.call.send(msg.say);
        return;
      }
      case "stop": {
        Main.aways.get(msg.call)?.call.stop();
        return;
      }
    }
  }

  // a call moved with its chat to `peer`'s process: what it sends and
  // ends goes where the chat is, by its ref: this process's address and
  // an id, or, fed here from further back, its own, passed on till its
  // origin feeds the chat's process itself (gone)
  export function away(peer: Peer, call: Call): string {
    const ref = Main.refs.get(call) ?? Main.addr + "#" + crypto.randomUUID();
    const away: Away = { call, link: peer };
    const end = (end: End) => {
      Main.aways.delete(ref);
      away.link.send({ $: "end", call: ref, end });
      Main.done();
    };
    Main.aways.set(ref, away);
    call.move({ on: (ev) => away.link.send({ $: "ev", call: ref, ev }), end });
    return ref;
  }

  // the call `ref` running elsewhere for a chat moved here from `back`: fed by
  // `back` if it runs there, else by its origin, asked to (take; its MCP
  // requests for the chat `key` then come straight here: Tools.went), what that
  // sends held till `back` passed on all that reached it (gone)
  export function far(back: Peer, ref: string, key: string, on: (ev: Event) => void): Call {
    const at = ref.slice(0, Math.max(0, ref.lastIndexOf("#")));
    const origin = at === Main.before ? back : Main.link(at);
    const send = (say: Say) => origin.send({ $: "send", call: ref, say });
    const [call, feed] = AskAI.tie(on, send, () => origin.send({ $: "stop", call: ref }));
    back.feeds.set(ref, feed);
    origin.feeds.set(ref, feed);
    if (origin !== back) {
      Main.gates.set(ref, { relay: back, origin, held: [], lost: false });
      origin.send({ $: "take", call: ref, key, tools: Tools.base() });
    }
    Main.refs.set(call, ref);
    return call;
  }

  // a call's relay passed on all that reached it: what its origin sent
  // since goes on, then the end its lost line meant
  export function open(ref: string, gate: Gate): void {
    Main.gates.delete(ref);
    gate.relay.feeds.delete(ref);
    gate.held.forEach((msg) => Main.told(gate.origin, msg));
    if (gate.lost) {
      gate.origin.feeds.get(ref)?.end(AskAI.end(ENDED));
      gate.origin.feeds.delete(ref);
    }
  }

  // once it gave all its chats and nothing it runs or passes on for them
  // is left, this process ends, its last requests answered (Main.leave)
  export function done(): void {
    if (Main.given && Chat.chats.size === 0 && Main.coming.size === 0 && Main.aways.size === 0) {
      Main.leave();
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
      Promise.all([...Main.peers].map((peer) => new Promise<void>((ok) => peer.end(ok)))).then(() => process.exit(0));
      return;
    }
    setTimeout(Main.leave, LEAVE);
  }

  // a line lost: if calls were fed over it from here, or it was the next
  // one's with chats still given it, that process crashed, and this one
  // ends too (the next start resumes all). Else the calls fed over it end
  // (a call's origin crashed; one its relay still passes on ends as that
  // says); the one before
  // frees what waits on it, and this one ends as it was to (Main.leave)
  export function lost(peer: Peer): void {
    Main.peers.delete(peer);
    Main.links.forEach((link, at) => link === peer && Main.links.delete(at));
    const fed = [...Main.aways.values()].some((away) => away.link === peer);
    if (fed || (peer === Main.next && (Chat.chats.size > 0 || Main.coming.size > 0))) {
      process.exit(1);
    }
    if (peer === Main.back) {
      Main.listed.resolve();
      Main.coming.forEach((c) => c.resolve());
      Main.coming.clear();
    }
    for (const [ref, feed] of peer.feeds) {
      const gate = Main.gates.get(ref);
      if (gate?.origin === peer) {
        gate.lost = true;
        continue;
      }
      gate?.origin.feeds.delete(ref);
      Main.gates.delete(ref);
      feed.end(AskAI.end(ENDED));
    }
    Main.done();
  }

  // a request for a chat this process gave away, sent where it went
  // (the only one on this port since)
  export function pass(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return fetch("http://127.0.0.1:" + Main.port + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body, redirect: "manual" });
  }

  // once the chat of `user` the worker before gives is here
  export async function here(user: string): Promise<void> {
    await Main.listed.promise;
    await Main.coming.get(user)?.promise;
  }

  // once all it gives are
  export async function arrived(): Promise<void> {
    await Main.listed.promise;
    await Promise.all([...Main.coming.values()].map((c) => c.promise));
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
    const cloud = Cloud.open(() => {});
    const workers: Bun.Subprocess[] = [];
    const all = new Set<Bun.Subprocess>();
    const hear = (k: number, proc: Bun.Subprocess, msg: any) => {
      switch (msg.$) {
        case "ready": {
          workers[k] = proc;
          return;
        }
      }
    };
    const start = (k: number) => {
      const env = { ...config.config_env(), KAZUKI_WORKER: String(k), BUN_CONFIG_MAX_HTTP_REQUESTS: String(FETCHES) };
      const ipc = (msg: any, proc: Bun.Subprocess) => hear(k, proc, msg);
      const proc = Bun.spawn([...run, String(port + 1 + k)], { env, ipc, stdio: ["ignore", "inherit", "inherit"] });
      all.add(proc);
      proc.exited.then((code) => {
        all.delete(proc);
        // again, unless slot k runs one now (a deploy's, ready meanwhile)
        Main.died(k, code, workers[k], proc, () => Main.runs(workers[k]) || start(k));
      });
    };
    Array.from({ length: config.WORKERS }, (_, k) => start(k));
    Main.forget(NETS);
    Bun.serve({
      port     : port,
      hostname : "127.0.0.1",
      fetch    : (req) => {
        if (!local_request(req)) {
          return new Response("loopback and same-origin requests only", { status: 403 });
        }
        if (!Main.spend(NETS, Cloud.net(Cloud.ip(req) ?? ""))) {
          return new Response("too many requests", { status: 429 });
        }
        const k = Main.shard(Cloud.who(cloud, req).id);
        return new Response(null, { headers: { "x-kazuki-worker": "127.0.0.1:" + (port + 1 + k) } });
      },
    });
    const stop = () => {
      Main.leaving = true;
      all.forEach((w) => w.kill());
      Promise.all([...all].map((w) => w.exited)).then(() => process.exit(0));
    };
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, stop);
    }
    process.on("SIGHUP", () => workers.forEach((_, k) => start(k)));
    console.log("kazuki: " + config.SITE + ", " + config.WORKERS + " workers on 127.0.0.1:" + (port + 1) + "-" + (port + config.WORKERS) + ", routes on " + port);
  }

  // whether a worker process runs
  export function runs(proc: Bun.Subprocess | undefined): boolean {
    return proc !== undefined && proc.exitCode === null && proc.signalCode === null;
  }

  // a worker ended (`now`: worker k's, the last that started): as the
  // server ends, nothing; one after a deploy (another is now, and runs)
  // too; worker k's again; one started in place of a dead one, again
  // after a pause (it fails until what stopped it is fixed: a provider
  // connected); one that never started (none is), the server ends
  export function died(k: number, code: number | null, now: Bun.Subprocess | undefined, proc: Bun.Subprocess, again: () => void): void {
    if (code !== 0) {
      console.error("kazuki: worker " + k + " ended (" + code + ")");
    }
    if (Main.leaving || (now !== proc && Main.runs(now))) {
      return;
    }
    if (now === undefined) {
      process.exit(1);
    }
    if (now === proc) {
      again();
    } else {
      setTimeout(() => Main.leaving || again(), RETRY);
    }
  }

}
