// Plugin
// ======
// What Kazuki is given comes as a plugin: an id, the plugin API it was
// written for (`api`: one this Kazuki has, else refused) and its setup,
// handed `k`, the hooks. The providers Kazuki ships are plugins too
// (BUILTIN; openai with Sign in with ChatGPT after its key); k.provider
// (provider.ts) is the one hook yet. load() sets each up once, in order;
// an id taken twice or an api not had stops the server. `kazuki auth`
// lists the providers, connects one and chooses its method, and pings
// each connected one (Plugin.ping).

import { Anthropic } from "../ai/anthropic.ts";
import { AskAI } from "../ai/ask-ai.ts";
import { ChatGPT } from "../ai/chatgpt.ts";
import { OpenAI } from "../ai/openai.ts";
import { Pick } from "../ai/pick.ts";
import { Providers, type Auth, type Provider } from "../ai/provider.ts";
import { Err, Ok, type Result } from "../util/result.ts";

// Types
// =====

// the hooks a plugin's setup is handed
export type K = { provider: (p: Provider) => void };

export type Plugin = { id: string; api: number; setup: (k: K) => void };

// Constants
// =========

// the plugin APIs this Kazuki has
const API = [1];

const BUILTIN: Plugin[] = [
  { id: "anthropic", api: 1, setup: (k) => k.provider(Anthropic.provider) },
  { id: "openai",    api: 1, setup: (k) => k.provider({ ...OpenAI.provider, auth: [...OpenAI.provider.auth, ChatGPT.signin] }) },
];

// what the server says, not starting, when no provider is connected
export const NONE = "Please connect any provider before starting Kazuki. To start, type `kazuki auth`.";

const LOADED = { done: false };

// the longest a ping waits for its answer (ms)
const PING = 20e3;

// Plugin
// ======

export namespace Plugin {

  export function load(): void {
    if (LOADED.done) {
      return;
    }
    LOADED.done = true;
    const ids = new Set<string>();
    for (const plugin of BUILTIN) {
      if (!API.includes(plugin.api)) {
        throw new Error("plugin " + plugin.id + " needs plugin API " + plugin.api + "; this Kazuki has " + API.join(", "));
      }
      if (ids.has(plugin.id)) {
        throw new Error("plugin " + plugin.id + " is loaded twice");
      }
      ids.add(plugin.id);
      plugin.setup({ provider: Providers.add });
    }
  }

  // whether a provider is connected
  export function ready(): boolean {
    Plugin.load();
    return Providers.all().some(Providers.connected);
  }

  // `kazuki auth [id [login | logout | use <key | oauth>]]`. A provider
  // set up is pinged as listed, chosen or signed in, and shown connected
  // only if it answers: a key set or a sign-in held is no proof it works
  // (its credit may be gone)
  export async function auth(args: string[]): Promise<Result<void, Error>> {
    Plugin.load();
    const [, id, act] = args;
    if (id === undefined) {
      const all = Providers.all();
      const pings = await quiet(() => Promise.all(all.map(Plugin.ping)));
      all.forEach((p, k) => {
        const a = Providers.active(p);
        const ping = pings[k];
        const state = a === undefined ? "not connected" : ping.ok ? "connected (" + Plugin.method(a) + ")" : "not connected: " + ping.error().message;
        console.log(p.id.padEnd(12) + p.name.padEnd(12) + state);
      });
      console.log("\nUse `kazuki auth <provider_id>` to connect a provider.");
      return new Ok();
    }
    const p = Providers.all().find((p) => p.id === id);
    if (p === undefined) {
      return new Err(new Error("no provider " + id + "; one of: " + Providers.all().map((p) => p.id).join(", ")));
    }
    if (act === "use") {
      const a = p.auth.find((a) => a.type === args[3]);
      if (a === undefined) {
        return new Err(new Error(id + " has no method " + args[3] + "; one of: " + p.auth.map((a) => a.type).join(", ")));
      }
      const chose = Providers.choose(id, a.type, true);
      if (!chose.ok) {
        return chose;
      }
      const bold = process.stdout.isTTY ? "\x1b[1m" + id + "\x1b[22m" : id;
      console.log("provider " + bold + " will now use " + Plugin.method(a) + (Providers.connected(p) ? "." : ", which isn't set up yet."));
      await check(p);
      return new Ok();
    }
    const oauth = p.auth.find((a) => a.type === "oauth");
    if (act === "login" || act === "logout") {
      if (oauth === undefined) {
        return new Err(new Error(id + " has no sign-in"));
      }
      if (act === "logout") {
        const out = await oauth.logout();
        if (!out.ok) {
          return new Err(out.error());
        }
        console.log(out.value());
        return new Ok();
      }
      const login = await oauth.login();
      if (!login.ok) {
        return login;
      }
      await check(p);
      return new Ok();
    }
    for (const a of p.auth) {
      console.log(a.type === "key" ? "Set " + a.envs.join(" and ") + " where the server starts." : "`kazuki auth " + id + " login`: sign in with " + a.name + "; `logout` signs out.");
    }
    console.log("A sign-in chooses itself; `kazuki auth " + id + " use key` or `use oauth` chooses. With none chosen, the first one set up is used.");
    return new Ok();
  }

  // a method as the user knows it: its key's variable, or the sign-in's name
  export function method(a: Auth): string {
    return a.type === "key" ? a.envs[0] : a.name;
  }

  // one small call on the provider's cheapest model, as the method used
  // runs it: Ok if it answers, else why not
  export async function ping(p: Provider): Promise<Result<void, Error>> {
    const c = Providers.offer().find((c) => c.id === p.id);
    if (c === undefined) {
      return new Err(new Error(Providers.connected(p) ? "no model offered: config models names none of its models" : "not connected"));
    }
    const model = Pick.cheapest(c.models);
    const pick = Pick.on({ vendor: p.id, model: model.label, effort: "low" }, p.id, model);
    const call = AskAI.ask({ ...Providers.ask(pick), system: "Reply with OK.", blocks: [{ text: "ping", mark: false }], searches: 0, server: "" }, () => {});
    // a check, not a turn: a busy or unreachable provider is not waited out
    const late = setTimeout(call.stop, PING);
    const end = await call.done.finally(() => clearTimeout(late));
    if (end.ok) {
      return new Ok();
    }
    return new Err(new Error(end.text === "stopped" ? "no answer in " + PING / 1e3 + " s" : end.text));
  }

  // says whether a connected provider works
  async function check(p: Provider): Promise<void> {
    if (Providers.connected(p)) {
      const ping = await quiet(() => Plugin.ping(p));
      console.log(ping.ok ? "Connected to " + p.name + "." : "Not connected: " + ping.error().message);
    }
  }

  // the vendor's words a call logs are kept from the terminal: the ping's
  // why says them
  async function quiet<T>(run: () => Promise<T>): Promise<T> {
    const log = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = log;
    }
  }

}
