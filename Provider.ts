// Provider
// ========
// The registry of providers: whom Kazuki calls (Agent.ts) and what may
// be picked (Pick.ts). A provider is what a plugin gives (k.provider:
// Plugin.ts): its id (a pick's vendor), its name, its models, how long
// it keeps a cache entry unused (ttl), how one connects it (auth) and
// its wire. The method used is the one chosen (config.AUTH: `kazuki
// auth <id> use`; a sign-in chooses itself), if it holds (a key method's
// variables all set, an oauth one signed in), else none: a choice never
// falls back to another method that bills elsewhere. With none chosen,
// the first that holds. It may run on its own wire, models and ttl (a
// ChatGPT sign-in runs openai on ChatGPT's backend: ChatGPT.ts). A
// provider with none used isn't connected. The offer, sent to every view, is the
// connected providers' catalogs, read again each time (a sign-in while
// the server runs shows at once), their models only those config
// `models` names, if it names any. A provider's own models are priced as
// models.dev prices them (ModelsDev.ts), unless it gives a price; a
// method's models as it gives them (a ChatGPT sign-in's: none).

import type { Wire } from "./Agent.ts";
import type { Vendor } from "./AskAI.ts";
import type { Catalog, Model, Offer, Pick } from "./Pick.ts";
import * as fs from "node:fs";
import * as config from "./Config.ts";
import { ModelsDev } from "./ModelsDev.ts";

// Types
// =====

// what a method changes when it is the one used (none: the provider's)
type Route = { wire?: Wire<any>; models?: Model[]; ttl?: number };

// a key method: the variables it needs, the first being the key the
// wire sends
export type Key = { type: "key"; envs: string[] } & Route;

// a sign-in: whether one is held, and how to make and end it (`kazuki
// auth`)
export type OAuth = { type: "oauth"; name: string; signed: () => boolean; login: () => Promise<void>; logout: () => Promise<string> } & Route;

export type Auth = Key | OAuth;

export type Provider = {
  id     : Vendor;
  name   : string;
  ttl    : number;
  models : Model[];
  auth   : Auth[];
  wire   : Wire<any>;
};

// Constants
// =========

const ALL = new Map<Vendor, Provider>();

// Providers
// =========

export namespace Providers {

  export function add(p: Provider): void {
    if (ALL.has(p.id)) {
      throw new Error("provider " + p.id + " is added twice");
    }
    ALL.set(p.id, p);
  }

  export function get(id: Vendor): Provider {
    const p = ALL.get(id);
    if (p === undefined) {
      throw new Error("no provider " + id);
    }
    return p;
  }

  export function all(): Provider[] {
    return [...ALL.values()];
  }

  // the auth method used: the one chosen, if it holds, else with none
  // chosen the first that holds
  export function active(p: Provider): Auth | undefined {
    const holds = (a: Auth) => (a.type === "key" ? a.envs.every((name) => config.secret(name) !== "") : a.signed());
    const type = Providers.chosen()[p.id];
    const chosen = p.auth.find((a) => a.type === type);
    return chosen === undefined ? p.auth.find(holds) : holds(chosen) ? chosen : undefined;
  }

  // each provider's chosen method, by its type
  export function chosen(): Record<Vendor, Auth["type"]> {
    try {
      return JSON.parse(fs.readFileSync(config.AUTH, "utf8")) ?? {};
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.error("kazuki: " + config.AUTH + " unreadable, no method chosen: " + err.message);
      }
      return {};
    }
  }

  // chooses provider id's method of this type (on), or drops it if it is
  // the one chosen (off)
  export function choose(id: Vendor, type: Auth["type"], on: boolean): void {
    const all = Providers.chosen();
    if (!on && all[id] !== type) {
      return;
    }
    if (on) {
      all[id] = type;
    } else {
      delete all[id];
    }
    fs.mkdirSync(config.DIR, { recursive: true });
    fs.writeFileSync(config.AUTH, JSON.stringify(all, null, 2));
    fs.chmodSync(config.AUTH, 0o600);
  }

  export function connected(p: Provider): boolean {
    return Providers.active(p) !== undefined;
  }

  // the wire, models and ttl calls run on, and the method used (none:
  // not connected)
  export function route(p: Provider): Required<Route> & { used?: Auth } {
    const a = Providers.active(p);
    return { wire: a?.wire ?? p.wire, models: a?.models ?? p.models, ttl: a?.ttl ?? p.ttl, used: a };
  }

  // the providers' catalogs: all of them, as they name their models, or
  // only the connected ones, as their methods run them (the offer)
  export function catalog(): Offer {
    return Providers.all().map((p) => Providers.shown(p, p.models)).filter((c) => c.models.length > 0);
  }

  export function offer(): Offer {
    const priced = (p: Provider) => p.models.map((m) => ({ ...m, rate: m.rate ?? ModelsDev.rate(p.id, m.id) }));
    return Providers.all().filter(Providers.connected).map((p) => Providers.shown(p, Providers.active(p)?.models ?? priced(p))).filter((c) => c.models.length > 0);
  }

  export function shown(p: Provider, models: Model[]): Catalog {
    return { id: p.id, name: p.name, models: models.filter((m) => config.MODELS === null || config.MODELS.includes(m.label)) };
  }

  // every key method's variables
  export function envs(): string[] {
    return [...new Set(Providers.all().flatMap((p) => p.auth.flatMap((a) => (a.type === "key" ? a.envs : []))))];
  }

  // as a call takes it: the model by its id, as the method used names it
  export function ask(pick: Pick): Pick {
    const p = ALL.get(pick.vendor);
    const model = p === undefined ? undefined : Providers.route(p).models.find((m) => m.label === pick.model);
    return { ...pick, model: model?.id ?? pick.model };
  }

}
