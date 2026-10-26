// Link
// ====
import { Err, Ok, type Result } from "../util/result.ts";
import { PING, MOVE, RETRY, TICK, WIRE, view_act, type Answer, type Client, type Done, type Link, type Post, type View } from "./view.ts";

// What TCP, WebSocket and HTTP do is theirs; the Link adds only what
// they can't. A socket that dies loses what was in flight: each act has
// an id and is kept until answered (its ack, or its post's answer); those
// not answered go again once the next socket shows the chat (none on a
// live one); the server does each once (views.ts Views.apply). An act
// with a body is a post of its own; one unanswered means the link is
// lost. A page sees no pings: the server ticks each PING / 2, and a view
// drops a socket silent for a PING. A socket closed as MOVE opens again
// at once, unseen: no link was lost.

export function link_open(v: View, link: Link): void {
  const ws   = link.open("?tab=" + v.tab + "&wire=" + WIRE);
  let heard  = Date.now();
  const tick = setInterval(() => Date.now() - heard > PING && drop(), PING / 2);
  async function drop(moved = false): Promise<void> {
    const up = v.up;
    ws.onmessage = null;
    ws.onclose   = null;
    clearInterval(tick);
    ws.close();
    [v.ws, v.up] = [null, false];
    if (moved || await link.lost(up)) {
      setTimeout(() => link_open(v, link), moved ? 0 : RETRY);
    }
  }
  // sends, in order, the acts not sent on this socket
  function flush(): void {
    for (const post of v.up && v.ws === ws ? v.out.filter((p) => p.ws !== ws) : []) {
      post.ws = ws;
      if ("body" in post.msg) {
        upload(post);
      } else {
        ws.send(JSON.stringify(post.msg));
      }
    }
  }
  async function upload(post: Post): Promise<void> {
    const { body, ...rest } = post.msg as any;
    const query = Object.entries(rest).map(([k, x]) => k + "=" + encodeURIComponent(String(x)));
    const res = await link.post("/api/act?" + query.join("&"), await body()).catch(() => null);
    const out = await res?.json().catch(() => null);
    if (out != null) {
      link.hear({ $: "ack", id: post.msg.id, ...out });
    } else if (post.ws === ws && v.ws === ws) {
      drop();
    }
  }
  [v.ws, v.flush] = [ws, flush];
  ws.onmessage = (ev) => {
    heard = Date.now();
    if (ev.data === TICK) {
      return;
    }
    const msg = JSON.parse(String(ev.data));
    const join = msg.$ === "view" && !v.up;
    if (join) {
      v.up = true;
      v.pages.clear();
    }
    link.hear(msg);
    if (join) {
      view_act(v, { $: "Goto", name: v.page?.name ?? null }).forEach((out) => link_send(v, out));
      flush();
    }
  };
  ws.onclose = (ev) => drop(ev.code === MOVE);
}

// an act, kept until answered; by default a refusal is a note; said: a
// message's text
export function link_send(v: View, msg: Client, done = (a: Done) => link_note(v, a), said = ""): void {
  v.out.push({ msg: { id: crypto.randomUUID(), ...msg }, ws: null, done, said });
  v.flush();
}

export function link_note(v: View, a: Done): void {
  if (!a.ok) {
    v.notes.push(a.error().message);
  }
}

// an act's answer as JSON, from its Result
export function answer_json(a: Done): Answer {
  if (a.ok) {
    return a.value();
  }
  const err = a.error();
  return err.status === undefined ? { error: err.message } : { error: err.message, status: err.status };
}

// an act's answer as a Result, from its JSON
export function answer_read(a: Answer): Done {
  if (typeof a?.error !== "string") {
    return new Ok({ text: a?.text, going: a?.going });
  }
  return new Err(Object.assign(new Error(a.error), a.status === undefined ? {} : { status: a.status }));
}

// a JSON post's answer: its JSON if its status was ok, else why not
export async function post(url: string, body: object, auth: Record<string, string> = {}): Promise<Result<any, Error>> {
  const headers = { ...auth, "content-type": "application/json" };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => null);
  if (res === null) {
    return new Err(new Error("Can't reach the server."));
  }
  const out = await res.json().catch(() => null);
  return res.ok ? new Ok(out ?? {}) : new Err(new Error(out?.error ?? "HTTP " + res.status));
}
