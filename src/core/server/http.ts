// Http
// ====
// What the server answers over HTTP: a site's files, a user's pages, a
// request routed to its chat.

import * as fs from "node:fs";
import { Cloud, type User } from "../cloud.ts";
import { Memory } from "../memory.ts";
import { answer_json } from "../../view/view.ts";
import * as config from "../../config.ts";
import { Sock, OWN, PIECE, SOCKETS, USERS, WEB, local_request } from "./shared.ts";
import { Chat } from "./chat.ts";
import { Handover } from "./handover.ts";
import { Ingest } from "./ingest.ts";
import { Main } from "./main.ts";
import { Views } from "./views.ts";

export namespace Http {

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
    await Handover.here(user.id);
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
  // a browser that doesn't say where it comes from: Http.http)
  export async function page(chat: Chat, user: User, p: string, req: Request): Promise<Response> {
    const mem = chat.mem;
    switch (p) {
      case "/tree": {
        return new Response(Http.stream(Memory.page(mem)), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      case "/export": {
        const name = "kazuki-memory-" + new Date().toISOString().slice(0, 10) + ".json";
        const json = { "content-type": "application/json", "content-disposition": 'attachment; filename="' + name + '"' };
        return new Response(Http.stream(Memory.dump(mem, await Cloud.data(Chat.cloud, user))), { headers: json });
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
  // so no client (Caddy, another worker's Handover.pass) keeps one to reuse as
  // the process ends
  export async function reply(req: Request, server: Bun.Server<Sock["data"]>): Promise<Response | undefined> {
    const res = await Http.http(req, server);
    if (res === undefined || !Handover.given) {
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
        return await Http.close(req);
      }
      if (!OWN.includes(p) && !p.startsWith("/image/") && !p.startsWith("/api/")) {
        return Http.file(p);
      }
      await Handover.here(user.id);
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
        return await Handover.pass(req);
      }
      chat.posts += 1;
      const res = await Http.page(chat, user, p, req).finally(() => (chat.posts -= 1));
      Chat.free(chat);
      return res;
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

}
