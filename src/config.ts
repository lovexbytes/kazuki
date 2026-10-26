// Config
// ======
// The server's settings. Its DIR ($KAZUKI_DIR, default ~/.kazuki) holds
// config.json, the lock and users/<id>. Each key of config.json (README)
// may be set as KAZUKI_<KEY> instead; a path may start with "~/". The
// picks are made from the providers connected, again each time they are
// used (config_live: a provider that disconnects while the server runs
// gives way at once): one not set is the first connected model (the
// compactor: that provider's cheapest); one naming no model a provider
// has is an error, which stops the server as it starts; one whose
// provider isn't connected gives way to the first connected model, and
// every view is told (Picks.lost). The secrets (API keys,
// APNS_KEY) are read from the environment then too (config_hide) and
// removed from it, so no program an agent runs inherits them, and put
// back for the workers.

import * as fs from "node:fs";
import * as os from "node:os";
import { EFFORTS, Pick, SPEEDS, type Model, type Offer } from "./ai/pick.ts";
import { Err, Ok, type Result } from "./util/result.ts";

// Constants
// =========

export const DIR = config_path(process.env.KAZUKI_DIR ?? "~/.kazuki");

const PATH = DIR + "/config.json";
const FILE: Record<string, string> = fs.existsSync(PATH) ? JSON.parse(fs.readFileSync(PATH, "utf8")) : {};

export const SITE    = config_get("site", "http://127.0.0.1:8788").replace(/\/$/, "");

// the models offered, by label (null: all)
export const MODELS     = config_get("models", "") ? config_get("models", "").split(",").map((m) => m.trim()) : null;

export const WORK       = config_path(config_get("work", DIR + "/work"));
export const RULES      = config_path(config_get("rules", ""));
export const AFTER      = config_get("after", "");
export const WORKERS    = Number(config_get("workers", "0"));

// the openai provider's ChatGPT sign-in (chatgpt.ts)
export const CHATGPT    = config_path(config_get("chatgpt", DIR + "/chatgpt.json"));

// each provider's chosen auth method, by its type (provider.ts)
export const AUTH       = DIR + "/auth.json";

// the iOS app (ios/, cloud.ts): its App ID, the team's then the bundle's
// ("TEAM.com.example.kazuki"), whose app sign-in links open; and
// the id of the key its pushes are signed with (APNS_KEY holds the key)
export const APPLE      = config_get("apple", "");
export const APNS       = config_get("apns", "");

// the picks: what a chat runs on until it picks another; what every
// compaction runs on, a chat's and an import's alike, whatever the
// chat's pick; what agents run on (null: the chat's pick); what the
// config set that isn't connected, and what runs in its place, told to
// every view (server.ts)
export type Picks = { pick: Pick; compactor: Pick; agents: Pick | null; lost: string[] };

// the picks made last (config_live)
let LAST: Picks | null = null;

// the secrets read from the environment, by variable (config_hide)
export const SECRETS = new Map<string, string>();

// Config
// ======

export function config_get(key: string, def: string): string {
  return process.env["KAZUKI_" + key.toUpperCase()] ?? FILE[key] ?? def;
}

function config_path(path: string): string {
  return path.startsWith("~/") ? os.homedir() + path.slice(1) : path;
}

// the picks, from the offer (the connected providers) and the catalog
// (every provider): one naming no model of the catalog fails
export function config_picks(offer: Offer, catalog: Offer): Result<Picks, Error> {
  const models = Pick.models(offer);
  if (models.length === 0 && MODELS !== null) {
    return new Err(new Error("Model not found: " + MODELS.join(", ") + ". Check your config (models) model names: no connected provider has them."));
  }
  if (models.length === 0) {
    return new Err(new Error("config: no provider is connected"));
  }
  const set = (["pick", "compactor", "agents"] as const).map((key) => config_pick(key, offer, catalog));
  const failed = set.find((p) => !p.ok);
  if (failed !== undefined && !failed.ok) {
    return new Err(failed.error());
  }
  const [pick, compactor, agents] = set.map((p) => (p.ok ? p.value() : null));
  const vendor = models[0][0];
  const cheapest = Pick.cheapest(models.filter(([v]) => v === vendor).map(([, m]) => m));
  const on = (model: Model, effort: string): Pick => Pick.on({ vendor, model: model.label, effort }, vendor, model);
  const picks: Picks = { pick: pick ?? on(models[0][1], "medium"), compactor: compactor ?? on(cheapest, "high"), agents, lost: [] };
  const lost = (key: string, got: Pick | null, runs: string) => {
    if (config_get(key, "") !== "" && got === null) {
      picks.lost.push(key + " " + config_get(key, "") + " isn't connected, so " + runs + ".");
    }
  };
  lost("pick", pick, "new chats run on " + Pick.label(picks.pick));
  lost("compactor", compactor, "summaries run on " + Pick.label(picks.compactor));
  lost("agents", agents, "agents run on the chat's pick");
  return new Ok(picks);
}

// the picks the providers connected now make; with none connected, the
// last made (a call on them says it isn't connected). The server made
// some as it started (server.ts serve), else it wouldn't have
export function config_live(offer: Offer, catalog: Offer): Picks {
  const now = config_picks(offer, catalog);
  if (now.ok) {
    LAST = now.value();
  }
  if (LAST === null) {
    throw new Error("config: picks used before any were made");
  }
  return LAST;
}

// a pick set as vendor:model[:effort][:speed], if offered (null: none
// set, or not connected); an effort or speed its model lacks steps down
// (Pick.on)
function config_pick(key: string, offer: Offer, catalog: Offer): Result<Pick | null, Error> {
  const text = config_get(key, "");
  const [vendor, model, ...rest] = text.split(":");
  const x = { vendor, model, effort: rest.find((r) => EFFORTS.includes(r)), speed: rest.find((r) => SPEEDS.includes(r)) };
  const odd = rest.some((r) => !EFFORTS.includes(r) && !SPEEDS.includes(r));
  if (text !== "" && odd) {
    return new Err(new Error("config: " + key + " is no provider:model[:effort][:speed]: " + text));
  }
  if (text !== "" && Pick.read(x, catalog) === null) {
    const hidden = MODELS !== null && !MODELS.includes(model) ? ", or add it to config models" : "";
    return new Err(new Error("Model not found: " + vendor + ":" + model + ". Check your config (" + key + ") provider:model names" + hidden + "."));
  }
  return new Ok(Pick.read(x, offer));
}

// a secret: read once hidden, else from the environment
export function secret(name: string): string {
  return SECRETS.get(name) ?? (process.env[name] ?? "").trim();
}

// reads these secrets and APNS_KEY, and removes them from the environment
export function config_hide(names: string[]): void {
  for (const name of [...names, "APNS_KEY"]) {
    SECRETS.set(name, secret(name));
    delete process.env[name];
  }
}

// the environment a worker of this server starts with: this one, with
// the secrets back
export function config_env(): Record<string, string | undefined> {
  return { ...process.env, ...Object.fromEntries([...SECRETS].filter(([, v]) => v !== "")) };
}
