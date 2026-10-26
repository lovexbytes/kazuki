// Cloud
// =====
// The self-hosted server has one local account. Old account rows and chats
// remain on disk, but are never selected by this server.

import type { Database } from "bun:sqlite";
import * as path from "node:path";
import * as config from "../config.ts";
import { Disk } from "./disk.ts";

export type User = { id: string; name: string };
export type Account = { cloud: Cloud; user: string };
export type Cloud = { db: Database; wal: string; change: (user: string) => void };

export const LOCAL: User = { id: "local", name: "local" };
const ACTS = 7 * 864e5;

const SCHEMA = `
create table if not exists acts (user text not null, id text not null, ans text not null, at integer not null, primary key (user, id));
create index if not exists acts_big on acts (at) where ans <> '{}';
`;

export namespace Cloud {
  export function open(change: Cloud["change"]): Cloud {
    const file = path.join(config.DIR, "cloud.db");
    const db = Disk.db(file);
    db.exec(SCHEMA);
    return { db, wal: file + "-wal", change };
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

  export async function data(_cloud: Cloud, user: User): Promise<object> {
    return { id: user.id, name: user.name };
  }

  export function close(cloud: Cloud, user: User): void {
    cloud.db.query("delete from acts where user = ?").run(user.id);
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
    switch (url.pathname) {
      case "/api/me": return Response.json({ id: user.id, name: user.name });
    }
    return null;
  }
}
