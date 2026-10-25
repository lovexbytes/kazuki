// ModelsDev
// =========
// The models' list prices, from models.dev: from
// the copy kept in DIR (models.json), else the snapshot Kazuki ships
// (models.txt; `bun ModelsDev.ts` makes it again). The server process
// holding the lock fetches the catalog again every 5 minutes (watch),
// unless the copy is fresh (a restart), and keeps a copy; its workers
// only read the copy again. A fetch that fails, or gives a catalog cut
// short, keeps what it had. Each model keeps only its prices. Config
// `models_fetch` "off": no fetch, the copy or the snapshot only.

import * as fs from "node:fs";
import * as config from "./Config.ts";
import type { Rate } from "./Price.ts";
import SNAPSHOT from "./models.txt" with { type: "text" };

// Types
// =====

type Cost = { input?: number; output?: number; cache_read?: number; cache_write?: number };

// by provider id, then by model id
type Catalog = Record<string, { models: Record<string, { cost: Cost }> }>;

type Stored = { at: number; body: Catalog };

// Constants
// =========

const API  = "https://models.dev/api.json";
const TTL  = 5 * 60e3;
const PATH = config.DIR + "/models.json";
const NOW: { catalog?: Catalog } = {};

// fewer providers: an error page or a body cut short, no catalog
const LEAST = 100;

// ModelsDev
// =========

export namespace ModelsDev {

  // a model's prices, if models.dev has them (its first tier: the
  // prices past a long context aren't shown)
  export function rate(provider: string, id: string): Rate | undefined {
    NOW.catalog ??= ModelsDev.stored()?.body ?? (JSON.parse(SNAPSHOT) as Catalog);
    const c = NOW.catalog[provider]?.models[id]?.cost;
    return c === undefined ? undefined : { input: c.input ?? 0, write: c.cache_write ?? 0, read: c.cache_read ?? 0, output: c.output ?? 0 };
  }

  export function stored(): Stored | undefined {
    try {
      return JSON.parse(fs.readFileSync(PATH, "utf8"));
    } catch {
      return undefined;
    }
  }

  // whether a copy needs no fetch: younger than half the period, so the
  // fetcher's own copy, a period old, is fetched again on its next tick
  export function fresh(stored: Stored | undefined, now: number): boolean {
    return stored !== undefined && now - stored.at < TTL / 2;
  }

  // models.dev's catalog, its prices only
  export async function fetched(): Promise<Catalog> {
    const res = await fetch(API, { headers: { "User-Agent": "kazuki" }, signal: AbortSignal.timeout(10e3) });
    if (!res.ok) {
      throw new Error(API + ": " + res.status);
    }
    const all: Record<string, { models?: Record<string, { cost?: Cost }> }> = await res.json();
    const priced = (models: Record<string, { cost?: Cost }>) => Object.entries(models).flatMap(([id, m]) => (m.cost === undefined ? [] : [[id, { cost: m.cost }]]));
    const body = Object.fromEntries(Object.entries(all).map(([id, p]) => [id, { models: Object.fromEntries(priced(p.models ?? {})) }]));
    if (Object.keys(body).length < LEAST) {
      throw new Error(API + " has " + Object.keys(body).length + " providers");
    }
    return body;
  }

  export async function refresh(): Promise<void> {
    const stored = ModelsDev.stored();
    if (ModelsDev.fresh(stored, Date.now())) {
      NOW.catalog = stored!.body;
      return;
    }
    try {
      const body = await ModelsDev.fetched();
      // whole or not at all: the workers read it
      fs.writeFileSync(PATH + ".tmp", JSON.stringify({ at: Date.now(), body }));
      fs.renameSync(PATH + ".tmp", PATH);
      NOW.catalog = body;
    } catch (err) {
      console.error("models.dev: " + (err as Error).message);
    }
  }

  // the copy, read again
  export function reload(): void {
    NOW.catalog = ModelsDev.stored()?.body ?? NOW.catalog;
  }

  // fetches: whether this process fetches, or only reads the copy again
  export function watch(fetches: boolean): void {
    if (config.config_get("models_fetch", "on") === "off") {
      return;
    }
    const tick = fetches ? () => void ModelsDev.refresh() : ModelsDev.reload;
    tick();
    setInterval(tick, TTL).unref();
  }

}

if (import.meta.main) {
  const body = await ModelsDev.fetched();
  await Bun.write(import.meta.dir + "/models.txt", JSON.stringify(body));
  console.log("models.txt: " + Object.keys(body).length + " providers");
}
