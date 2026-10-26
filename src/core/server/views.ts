// Views
// -----
// what a chat shows its sockets, and the acts they send.

import * as fs from "node:fs";
import { Cloud } from "../cloud.ts";
import { Disk } from "../disk.ts";
import { Memory } from "../memory.ts";
import { Pick } from "../../ai/pick.ts";
import { Providers } from "../../ai/provider.ts";
import { Tools } from "../tools.ts";
import { SUMMARIES, TURN, answer_json, answer_read, type Done, type Part, type Server as Out, type Wait } from "../../view/view.ts";
import * as config from "../config.ts";
import { caught, Err, Ok, type Result } from "../../util/result.ts";
import { Sock, Eye, FULL, SPARE, BODIES } from "./shared.ts";
import { Chat } from "./chat.ts";
import { Ingest } from "./ingest.ts";

export namespace Views {

  // -----
  // A socket message carries at most one log entry, summary or job, so
  // none is too large to hear the next tick in time.

  export function all(chat: Chat, msg: Out): void {
    chat.socks.forEach((sock) => Views.send(sock, msg));
  }

  export function send(sock: Sock, msg: object): void {
    sock.send(JSON.stringify(msg));
  }

  export function state(chat: Chat): Out {
    const agents = Tools.working(chat.tools).map((a) => a.name);
    const batch = chat.batch;
    const why = chat.mem.paused ? "paused" : null;
    const importing = batch && { done: batch.all - Ingest.time(batch), total: batch.all, why, msgs: batch.b - batch.a, open: batch.open };
    return { $: "state", busy: chat.busy, wait: Views.waits(chat), agents, pick: chat.pick, providers: Providers.offer(), importing };
  }

  export function waits(chat: Chat): Wait {
    if (chat.call !== null) {
      return chat.asked ? chat.model : "";
    }
    const summing = chat.busy && chat.wait.length > 0 && Memory.first(chat.mem) < Chat.from(chat);
    return summing ? SUMMARIES : "";
  }

  // what runs is saved, unless the chat ended; the state goes to every view
  export function change(chat: Chat): void {
    const work = Chat.running(chat);
    if (Chat.chats.get(chat.acct.user) === chat && String(work) !== String(chat.mem.work)) {
      chat.mem.work = work;
      Memory.save(chat.mem);
    }
    Views.all(chat, Views.state(chat));
    Chat.free(chat);
  }

  // a view joins on the chat as it is now; a terminal's device too (told
  // its name if its host's was taken)
  export function join(chat: Chat, sock: Sock): void {
    const { tab, host, computer, work } = sock.data;
    chat.socks.add(sock);
    Views.send(sock, Views.state(chat));
    Views.show(chat, sock);
    Views.send(sock, { $: "live", live: chat.live });
    if (host === null) {
      return;
    }
    const link = { send: (msg: object) => Views.send(sock, msg), live: () => chat.socks.has(sock), computer, work };
    sock.data.device = Tools.attach(chat.tools, tab, host, sock.data.who, link);
    if (sock.data.device !== host) {
      Views.send(sock, { $: "note", text: host + " was taken: Kazuki calls this computer " + sock.data.device + "." });
    }
  }

  // a socket closed; a terminal's device goes only if it quit (a link lost
  // is no quit)
  export function leave(chat: Chat, sock: Sock, quit: boolean): void {
    chat.socks.delete(sock);
    if (quit && sock.data.device !== null) {
      Tools.detach(chat.tools, sock.data.tab, sock.data.device);
    }
    Chat.free(chat);
  }

  // a view's message answered (ack): a read at once, else as Views.apply
  // does it. A client sends it, so it may be anything: one not JSON is
  // answered why; one that throws (a field missing) is answered its
  // error and logged (Views.fail), never ending the process, which serves
  // other users too
  export async function answer(chat: Chat, sock: Sock, data: string): Promise<void> {
    chat.posts += 1;
    const parsed = Views.json(data);
    const msg = parsed.ok ? parsed.value() : null;
    const out = parsed.ok ? await Promise.try(() => Views.ask(chat, sock, msg) ?? Views.apply(chat, msg, sock.data.device ?? "")).catch(Views.fail) : new Err(parsed.error());
    chat.posts -= 1;
    Views.send(sock, { $: "ack", id: msg?.id, ...answer_json(out) });
    Chat.free(chat);
  }

  // a client's message, parsed
  export function json(data: string): Result<any, Error> {
    try {
      return new Ok(JSON.parse(data));
    } catch (e) {
      return caught(e);
    }
  }

  // what a message or act that threw answers
  export function fail(err: unknown): Done {
    console.error("kazuki: an act failed: " + ((err as Error)?.stack ?? err));
    return caught(err);
  }

  // a read, answered by what it sends; null: no read
  export function ask(chat: Chat, sock: Sock, msg: any): Done | null {
    switch (msg.$) {
      case "zoom": {
        const [id, n] = [...msg.part].map(Number);
        if (n > 1 && Memory.part(chat.mem, id, n) !== null) {
          const parts: Part[] = [[id, n / 2], [id + n / 2, n / 2]];
          Views.teach(chat, sock, parts);
          Views.send(sock, { $: "zoom", id, n, parts });
        }
        return new Ok({});
      }
      case "root": {
        const parts = Memory.roots(chat.mem.count).map(({ l, i }): Part => [i * 2 ** l, 2 ** l]);
        Views.teach(chat, sock, parts);
        Views.send(sock, { $: "root", parts });
        return new Ok({});
      }
      case "agent": {
        const name = String(msg.name);
        const log = Memory.agent(chat.mem, name);
        Views.send(sock, { $: "agent", name, found: log !== null });
        log?.forEach(({ kind, text, date }) => Views.send(sock, { $: "entry", agent: name, kind, text, date }));
        Views.send(sock, { $: "live", agent: name, live: chat.tools.agents.get(name)?.live ?? [] });
        return new Ok({});
      }
    }
    return null;
  }

  // THE apply point: every change is done here once, however often it
  // comes. An act being done, or recorded done (its record's answer, kept
  // by Cloud.act_put as the log indexes it), gets that answer; else
  // Views.act does it, answered once on disk
  export function apply(chat: Chat, msg: any, device: string): Promise<Done> {
    const id = String(msg.id);
    const doing = chat.acts.get(id);
    if (doing !== undefined) {
      return doing;
    }
    const was = Cloud.act_get(chat.acct, id);
    if (was !== null) {
      return Promise.resolve(answer_read(was));
    }
    const run = Views.act(chat, id, msg, device).catch(Views.fail).then(async (out) => {
      await Disk.synced();
      chat.acts.delete(id);
      return out;
    });
    chat.acts.set(id, run);
    return run;
  }

  // an act changes the chat. One that would change it again if done again
  // (a post adds again; a stop ends what runs by then) is recorded: logged
  // (Views.mark) before any effect off the log, or as the last page of
  // what it logs. The rest
  // set state (a pick: view.json; an import's hold: its file) or end a
  // job, so done again they change nothing, and only that state is kept,
  // written over; a stop with nothing to stop is one (so one a client
  // sends again, its answer lost, may end what runs by then)
  export async function act(chat: Chat, id: string, msg: any, device: string): Promise<Done> {
    if ("req" in msg && BODIES.includes(msg.$)) {
      return Views.post(chat, id, msg);
    }
    switch (msg.$) {
      case "stop": {
        const name = msg.name === undefined ? null : String(msg.name);
        const what = Chat.running(chat).filter((w) => name === null || w === name);
        const why = "Stopped by the user: " + what.join(", ") + ".";
        const turn = what.includes(TURN);
        if (what.length === 0) {
          return new Ok({});
        }
        Views.mark(chat, id, {});
        if (turn) {
          Chat.interrupt(chat, why);
        }
        what.forEach((w) => Tools.stop(chat.tools, w));
        if (!turn) {
          Chat.note(chat, why);
        }
        return new Ok({});
      }
      case "goal": {
        const goal = msg.text === null ? null : String(msg.text);
        if (goal === chat.mem.goal) {
          return new Ok({});
        }
        chat.mem.goal = goal;
        Memory.save(chat.mem);
        if (goal === null) {
          Chat.note(chat, "Goal halted by the user.");
        }
        return new Ok({});
      }
      case "go": {
        return Ingest.go(chat, msg.on === true || msg.on === "true");
      }
      case "pick": {
        const pick = Pick.read(msg.to, Providers.offer());
        if (pick === null) {
          return new Err(new Error("No pick " + JSON.stringify(msg.to) + "."));
        }
        chat.pick = chat.mem.pick = pick;
        Memory.save(chat.mem);
        Views.change(chat);
        return new Ok({});
      }
      case "out": {
        Tools.done(chat.tools, device, String(msg.job), msg.out);
        return new Ok({});
      }
    }
    return new Err(new Error("No act " + msg.$ + "."));
  }

  // a post (msg.req) refused before a byte of its body is read: under
  // SPARE free, 507. Else its body goes to a file unlinked once open,
  // then its act is done
  export async function post(chat: Chat, id: string, msg: any): Promise<Done> {
    const disk = fs.statfsSync(config.DIR);
    if (disk.bavail * disk.bsize < SPARE) {
      return new Err(Object.assign(new Error(FULL), { status: 507 }));
    }
    const file = chat.mem.dir + "/up/" + crypto.randomUUID();
    fs.mkdirSync(chat.mem.dir + "/up", { recursive: true });
    const body = { fh: await fs.promises.open(file, "w+"), size: 0 };
    fs.rmSync(file);
    try {
      for await (const data of msg.req.body ?? []) {
        await body.fh.write(data);
        body.size += data.length;
      }
      switch (msg.$) {
        case "say": {
          return await Chat.say(chat, id, msg.sizes.split(",").filter(Boolean).map(Number), body);
        }
        case "import": {
          return await Chat.writing(chat, () => Ingest.ingest(chat, id, body));
        }
        case "voice": {
          return await Chat.voice(chat, id, String(msg.type), body);
        }
      }
      return new Err(new Error("No act " + msg.$ + "."));
    } catch (e) {
      // its body unread or cut short (Chat.pieces)
      return caught(e);
    } finally {
      await body.fh.close();
    }
  }

  // an act's record, a line of its own (memory.ts)
  export function mark(chat: Chat, id: string, rec: object): void {
    Memory.log(chat.mem, "main", [{ act: id, ...rec }]);
  }

  export function eye(mem: Memory, from: number): Eye {
    const parts = Memory.before(mem.view.parts, from).map((part): Part => [Memory.span(part)[0], 2 ** part.l]);
    return { parts, from };
  }

  // what the agent saw: the eye's parts, then each message after them;
  // a running import's messages, wherever they are, as the fewest blocks
  // of the tree that hold them, built or not (a summary not built comes
  // once built: Ingest.made), so no view ever gets the raw history; a block
  // opened gets its halves (zoom); they start where the tree's root
  // holding the import's first message starts, so the oldest blocks are
  // the largest, as in the tree, not grown from an unaligned start
  export function show(chat: Chat, sock: Sock): void {
    const [from, count] = [chat.eye.from, chat.mem.count];
    const [a, hi] = chat.batch === null ? [0, 0] : [chat.batch.a, chat.batch.b];
    const root = Memory.roots(count).find((part) => Memory.span(part)[1] >= a);
    const lo = root === undefined ? a : Memory.span(root)[0];
    const near = chat.eye.parts.filter(([id, n]) => id < hi && id + n > lo);
    const cover: [number, number] = [Math.min(lo, ...near.map(([id]) => id)), Math.max(hi, ...near.map(([id, n]) => id + n))];
    const eye = chat.eye.parts.filter(([id, n]) => id + n <= cover[0] || id >= cover[1]);
    const tree = Memory.roots(count).flatMap((part) => Views.blocks(part, cover));
    const ids = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, k): Part => [a + k, 1]);
    const raw = [...ids(from, cover[0]), ...ids(Math.max(from, cover[1]), count)];
    const parts = [...eye, ...tree, ...raw].sort((x, y) => x[0] - y[0]);
    Views.teach(chat, sock, parts);
    Views.send(sock, { $: "view", parts, turn: from });
  }

  // the fewest blocks under a tree part that tile messages [a, b)
  export function blocks(part: { l: number; i: number }, [a, b]: [number, number]): Part[] {
    const [first, last] = Memory.span(part);
    if (last < a || first >= b) {
      return [];
    }
    if (first >= a && last < b) {
      return [[first, 2 ** part.l]];
    }
    return Memory.halves(part).flatMap((half) => Views.blocks(half, [a, b]));
  }

  // what a view lacks of parts, before the parts themselves: each
  // message or summary a message of its own (Views); a summary not built
  // yet, once built (Ingest.made)
  export function teach(chat: Chat, sock: Sock, parts: Part[]): void {
    for (const [id, n] of parts.filter(([id, n]) => !sock.data.seen.has(id + "+" + n))) {
      sock.data.seen.add(id + "+" + n);
      if (n === 1) {
        const m = Memory.message(chat.mem, id)!;
        Views.send(sock, { $: "know", whole: { [id]: { kind: m.kind, text: m.text, date: m.date, images: m.images } } });
      }
      Views.know(chat, sock, id, n);
    }
  }

  // a summary, if built, to a view shown its block
  export function know(chat: Chat, sock: Sock, id: number, n: number): void {
    const text = Memory.node(chat.mem, { l: Math.log2(n), i: id / n });
    if (text !== null) {
      Views.send(sock, { $: "know", nodes: { [id + "+" + n]: { text, to: Memory.message(chat.mem, id + n - 1)!.date } } });
    }
  }
}
