// Cloud
// =====
// The self-hosted server has one local account. Old account rows and chats
// remain on disk, but are never selected by this server.

import type { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as http2 from "node:http2";
import * as path from "node:path";
import { Billing } from "./Billing.ts";
import * as config from "./Config.ts";
import { Disk } from "./Disk.ts";

export type User = { id: string; name: string };
export type Account = { cloud: Cloud; user: string };
export type Cloud = { db: Database; wal: string; change: (user: string) => void; billing: Billing };

export const LOCAL: User = { id: "local", name: "local" };
const ACTS = 7 * 864e5;
const PUSH = { link: null as http2.ClientHttp2Session | null, jwt: "", at: 0 };
const PUSH_AGE = 40 * 60 * 1000;

// Keep obsolete account tables intact for existing installations. Pushes use a
// stable local session value so old schemas with a non-null session still work.
const SCHEMA = `
create table if not exists pushes (token text primary key, session text not null, user text not null);
create index if not exists pushes_user on pushes (user);
create table if not exists acts (user text not null, id text not null, ans text not null, at integer not null, primary key (user, id));
create index if not exists acts_big on acts (at) where ans <> '{}';
`;

export namespace Cloud {
  export function open(change: Cloud["change"]): Cloud {
    const file = path.join(config.DIR, "cloud.db");
    const db = Disk.db(file);
    db.exec(SCHEMA);
    const base = { db, wal: file + "-wal", change };
    const billing = Billing.open(base);
    if (billing.bills && config.OFFER.vendors.includes("openai-sub")) {
      throw new Error("config: a server that bills can't offer openai-sub (a ChatGPT plan is one person's, not its users)");
    }
    return { ...base, billing };
  }

  export function who(_cloud: Cloud, _req: Request): User { return LOCAL; }
  export function user(_cloud: Cloud, id: string): User | null { return id === LOCAL.id ? LOCAL : null; }

  export function ip(req: Request): string | null {
    return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
  }

  // an IPv4 address (including one written as IPv6), or an IPv6 /48
  export function net(ip: string): string {
    const v4 = /(\d+\.){3}\d+$/.exec(ip);
    if (v4 !== null || !ip.includes(":")) return v4?.[0] ?? ip;
    const [head, tail = ""] = ip.toLowerCase().split("::");
    const a = head === "" ? [] : head.split(":");
    const b = tail === "" ? [] : tail.split(":");
    const all = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
    return all.slice(0, 3).map((h) => parseInt(h, 16).toString(16)).join(":") + "::/48";
  }

  export async function data(cloud: Cloud, user: User): Promise<object> {
    return { id: user.id, name: user.name, ...(await cloud.billing.data(user)) };
  }

  export async function close(cloud: Cloud, user: User, req: Request): Promise<string | null> {
    const why = await cloud.billing.close(user, req);
    if (why === null) {
      cloud.db.query("delete from pushes where user = ?").run(user.id);
      cloud.db.query("delete from acts where user = ?").run(user.id);
    }
    return why;
  }

  export function push(cloud: Cloud, user: string, text: string): void {
    if (!config.APNS || !config.KEYS.apns) return;
    const phones = cloud.db.query("select token from pushes where user = ?").all(user) as { token: string }[];
    const body = JSON.stringify({ aps: { alert: { body: text.replace(/\s+/g, " ").slice(0, 200) }, sound: "default" } });
    for (const { token } of phones) {
      const link = Cloud.apns();
      const req = link.request({ ":method": "POST", ":path": "/3/device/" + token, authorization: "bearer " + PUSH.jwt, "apns-topic": config.APPLE.replace(/^[^.]*\./, ""), "apns-push-type": "alert" });
      let out = "";
      req.setEncoding("utf8"); req.on("data", (got) => out += got);
      req.on("error", (err) => console.error("push: " + err.message));
      req.on("end", () => { if (/Unregistered|BadDeviceToken/.test(out)) cloud.db.query("delete from pushes where token = ?").run(token); else if (out) console.error("push: " + out); });
      req.end(body);
    }
  }

  export function apns(): http2.ClientHttp2Session {
    if (PUSH.link === null || PUSH.link.closed || PUSH.link.destroyed) {
      const link = PUSH.link = http2.connect("https://api.push.apple.com");
      link.on("error", (err) => console.error("push: " + err.message));
      link.on("close", () => PUSH.link === link && (PUSH.link = null));
    }
    if (Date.now() - PUSH.at > PUSH_AGE) {
      const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
      const head = b64({ alg: "ES256", kid: config.APNS }) + "." + b64({ iss: config.APPLE.split(".")[0], iat: Math.floor(Date.now() / 1000) });
      const key = crypto.createPrivateKey({ key: Buffer.from(config.KEYS.apns.replace(/-----[^-]+-----|\s/g, ""), "base64"), format: "der", type: "pkcs8" });
      PUSH.jwt = head + "." + crypto.sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
      PUSH.at = Date.now();
    }
    return PUSH.link!;
  }

  export function act_put(acct: Account, id: string, ans: object): void {
    acct.cloud.db.query("update acts set ans = '{}' where at < ? and ans <> '{}'").run(Date.now() - ACTS);
    acct.cloud.db.query("insert or ignore into acts values (?, ?, ?, ?)").run(acct.user, id, JSON.stringify(ans), Date.now());
  }
  export function act_get(acct: Account, id: string): object | null {
    const row = acct.cloud.db.query("select ans from acts where user = ? and id = ?").get(acct.user, id) as { ans: string } | null;
    return row === null ? null : JSON.parse(row.ans);
  }

  export async function http(cloud: Cloud, req: Request): Promise<Response | null> {
    const user = LOCAL;
    const url = new URL(req.url);
    const billed = await cloud.billing.http(req, user);
    if (billed !== null) return billed;
    switch (url.pathname) {
      case "/api/me": await cloud.billing.balance(user.id); return Response.json({ id: user.id, name: user.name, bills: cloud.billing.bills, credits: cloud.billing.credits(user.id) });
      case "/api/account": await cloud.billing.balance(user.id); return Response.json({ ...(await Cloud.data(cloud, user)), bills: cloud.billing.bills, credits: cloud.billing.credits(user.id) });
      case "/api/push": {
        const token = (await req.text()).trim();
        if (!/^[0-9a-f]{64,256}$/.test(token)) return Response.json({ error: "Not a push token" }, { status: 400 });
        cloud.db.query("insert or replace into pushes values (?, ?, ?)").run(token, "local", user.id);
        return Response.json({ ok: true });
      }
    }
    return null;
  }
}
