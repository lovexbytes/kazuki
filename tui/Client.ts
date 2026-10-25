// Client
// ======
// The terminal's link to a Kazuki server, with no drawing: a View
// (View.ts) fed by the server's socket, the person's acts sent back,
// and, while open, a device the agent's tools reach (its jobs run here,
// Machine.ts). The server is standalone and owns the chat; this is one
// of its views, local or remote, as the web is. The UI (App.tsx) reads
// the View after each `rev` and tells the person what the hooks say.

import * as os from "node:os";
import { batch, createSignal, type Accessor } from "solid-js";
import { Machine, type Job } from "../Machine.ts";
import type { Result } from "../Result.ts";
import * as View from "../View.ts";

// Types
// =====

// what the UI shows for the client: a note (a toast), a sheet (a page
// of markdown: /help, an import's plan), a message refused
// (back in the input), a pick to make (a list), the end
export type Hooks = {
  note  : (text: string) => void;
  sheet : (title: string, md: string) => void;
  back  : (sent: View.Sent) => void;
  pick  : (move: "model" | "effort" | "speed") => void;
  quit  : () => void;
};

// v: the View; rev: changes at each change to it (a frame at most);
// log: only at a change to the chat's rows, not to what streams (a long
// chat's rows are not made again at each piece of a stream);
// jobs: the agent's jobs running here; imgs: for the next message;
// since: when the turn running started (ms; 0: none); pending: commands
// at work (a pipe waits for them)
export type Client = {
  v      : View.View;
  url    : string;
  device : string;
  work   : string;
  screen : boolean;
  jobs   : Map<string, AbortController>;
  rev    : Accessor<number>;
  log    : Accessor<number>;
  bump   : (rows?: boolean) => void;
  imgs   : Accessor<Blob[]>;
  setImgs: (imgs: Blob[]) => void;
  since  : number;
  pending: number;
  hooks  : Hooks;
  heard  : ((msg: View.Server) => void)[];
};

// Constants
// =========

// how often the UI hears of changes at most (ms): a stream's pieces come
// faster than a screen shows them
const FRAME = 16;

// Client
// ======

export function client_new(url: string, device: string, work: string, screen: boolean): Client {
  const [rev, setRev]     = createSignal(0);
  const [log, setLog]     = createSignal(0);
  const [imgs, setImgs]   = createSignal<Blob[]>([]);
  let due  = false;
  let rows = false;
  const c: Client = {
    v      : View.view_new(),
    url,
    device,
    work,
    screen,
    jobs   : new Map(),
    rev,
    log,
    bump   : (changed = true) => {
      rows = rows || changed;
      if (!due) {
        due = true;
        setTimeout(() => {
          batch(() => {
            setRev((n) => n + 1);
            if (rows) {
              setLog((n) => n + 1);
            }
          });
          due  = false;
          rows = false;
        }, FRAME);
      }
    },
    imgs,
    setImgs,
    since  : 0,
    pending: 0,
    hooks  : { note: () => {}, sheet: () => {}, back: () => {}, pick: () => {}, quit: () => {} },
    heard  : [],
  };
  return c;
}

// connects, by View's link, naming this device
export function client_connect(c: Client): void {
  const dev = "&device=" + encodeURIComponent(c.device) + "&computer=" + (c.screen ? 1 : 0) + "&work=" + encodeURIComponent(c.work);
  View.link_open(c.v, {
    open : (query) => new WebSocket(c.url.replace(/^http/, "ws") + "/ws" + query + dev),
    post : (path, body) => fetch(c.url + path, { method: "POST", body }),
    hear : (msg) => client_hear(c, msg),
    lost : async () => {
      c.bump();
      return true;
    },
  });
}

// a message of the server: to the view, then to the jobs; notes go to
// the UI as they come
function client_hear(c: Client, msg: View.Server): void {
  const was = c.v.busy;
  for (const out of View.view_hear(c.v, msg)) {
    client_send(c, out);
  }
  if (msg.$ === "jobs" || msg.$ === "job") {
    client_jobs(c, msg);
  }
  if (c.v.busy && !was) {
    c.since = Date.now();
  } else if (!c.v.busy) {
    c.since = 0;
  }
  client_notes(c);
  c.heard.forEach((f) => f(msg));
  c.bump(msg.$ !== "delta" && msg.$ !== "live");
}

// the view's notes, to the UI
function client_notes(c: Client): void {
  for (const text of c.v.notes.splice(0)) {
    c.hooks.note(text);
  }
}

// an act of the person: to the view; the messages it sends the server
export function client_act(c: Client, act: View.Act): View.Client[] {
  const out = View.view_act(c.v, act);
  out.forEach((msg) => client_send(c, msg, act.$ === "Send" ? act : undefined));
  client_notes(c);
  c.bump();
  return out;
}

// an act to the server; a message refused goes back in the input
export function client_send(c: Client, msg: View.Client, sent?: View.Sent): void {
  const said = sent === undefined ? "" : sent.text.trim();
  View.link_send(c.v, msg, (a) => {
    if (!a.ok) {
      c.hooks.note(a.error().message);
    }
    if (!a.ok && sent !== undefined) {
      c.hooks.back(sent);
    }
    c.bump();
  }, said);
  c.bump();
}

// a message typed: sent with the images attached; false: nothing went
export function client_say(c: Client, text: string): boolean {
  const sent = client_act(c, { $: "Send", text, images: c.imgs() });
  if (sent.length > 0) {
    c.setImgs([]);
    return true;
  }
  return false;
}

// the user's messages known, oldest first (the input's history)
export function client_history(c: Client): string[] {
  return [...c.v.whole].sort((a, b) => a[0] - b[0]).flatMap(([, e]) => (e.kind === "user" ? [e.text] : []));
}

// a GET of the server; failing, a note says it could not do `what`
export async function client_get(c: Client, path: string, what: string): Promise<Response | null> {
  const res = await fetch(c.url + path).catch(() => null);
  if (res === null || !res.ok) {
    c.hooks.note("Could not " + what + ": " + (res === null ? "no connection" : "HTTP " + res.status) + ".");
    return null;
  }
  return res;
}

// a JSON POST to the server (View.post)
export function client_post(c: Client, path: string, body: object): Promise<Result<any, Error>> {
  return View.post(c.url + path, body);
}

// leaves, telling the server; its jobs here end as the process exits
// (main.tsx)
export function client_close(c: Client): void {
  c.v.ws?.close(View.QUIT);
}

// a path as typed or dropped: quoted, escaped, ~
export function path_read(arg: string): string {
  return arg.trim().replace(/^(['"])(.*)\1$/, "$2").replace(/\\(.)/g, "$1").replace(/^~(?=\/|$)/, os.homedir());
}

// Jobs
// ====

// the server's word on this device's jobs: a job, run unless it runs or
// its output waits for an answer; or their ids, the rest halted
function client_jobs(c: Client, msg: View.Server & { $: "jobs" | "job" }): void {
  if (msg.$ === "job") {
    const sent = c.v.out.some((p) => p.msg.$ === "out" && p.msg.job === msg.id);
    if (!c.jobs.has(msg.id) && !sent) {
      client_run(c, msg.id, msg.job as Job);
    }
    return;
  }
  for (const [id, abort] of c.jobs) {
    if (!msg.ids.includes(id)) {
      abort.abort();
    }
  }
}

// runs a job here, and answers its output; one too large for a socket
// message (View.FRAME, the 1 KiB left for the act around it) answers its
// size instead, failed (sent, it would close the socket at every try)
async function client_run(c: Client, id: string, job: Job): Promise<void> {
  const abort = new AbortController();
  c.jobs.set(id, abort);
  c.bump();
  const no   = { text: "This terminal does no computer use.", fail: true };
  const out  = job.name === "computer" && !c.screen ? no : await Machine.run(job, c.work, abort.signal);
  const size = Buffer.byteLength(JSON.stringify(out));
  const most = View.FRAME - 1024;
  const big  = { text: "The output, " + size + " bytes, is over the " + most + " a tool may send.", fail: true };
  c.jobs.delete(id);
  client_send(c, { $: "out", job: id, out: size > most ? big : out });
}
