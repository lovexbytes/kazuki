// Provider test
// =============
// `bun test Provider.test.ts`. The registry the built-in plugins fill:
// only connected providers are offered, a key's models priced as
// models.dev prices them, a pick not set is the first connected model
// (the compactor: that provider's cheapest),
// one set whose provider isn't connected gives way to it and is told,
// the picks follow the providers connected now,
// one naming no model is an error, a sign-in file without its tokens
// connects nothing, the keys leave the environment, with none connected
// the server doesn't start, a call names its model as the method
// used names it, a ping says why a provider fails, and voice bills
// only a key chosen.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import type { OAuth } from "./Provider.ts";
import { Ok } from "./Result.ts";

const DIR = fs.mkdtempSync(os.tmpdir() + "/kazuki-provider-");
process.env.KAZUKI_DIR = DIR;
delete process.env.KAZUKI_PICK;
delete process.env.KAZUKI_COMPACTOR;
delete process.env.KAZUKI_AGENTS;
delete process.env.KAZUKI_MODELS;

// a known copy of models.dev's prices, read before the snapshot
const COST = { input: 1, cache_write: 2, output: 4 };
fs.writeFileSync(DIR + "/models.json", JSON.stringify({ at: Date.now(), body: {
  openai    : { models: { "gpt-6-luna": { cost: COST } } },
  anthropic : { models: { "claude-opus-5-5": { cost: { output: 25 } }, "claude-haiku-5-5": { cost: { output: 5 } } } },
} }));

const config = await import("./Config.ts");
const { Plugin } = await import("./Plugin.ts");
const { Providers } = await import("./Provider.ts");
const { Pick } = await import("./Pick.ts");

// only an OpenAI key (the ChatGPT sign-in file is in the empty DIR: none)
config.SECRETS.set("ANTHROPIC_API_KEY", "");
config.SECRETS.set("OPENAI_API_KEY", "test");

const picks = () => config.config_picks(Providers.offer(), Providers.catalog());
const why = () => {
  const got = picks();
  return got.ok ? "" : got.error().message;
};

test("only the connected providers are offered", () => {
  expect(Plugin.ready()).toBe(true);
  expect(Providers.offer().map((p) => p.id)).toEqual(["openai"]);
  expect(Providers.catalog().map((p) => p.id)).toEqual(["anthropic", "openai"]);
  expect(Providers.envs()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
});

test("a key's models are priced as models.dev prices them; a sign-in's are not", () => {
  expect(Pick.model(Providers.offer(), "openai", "gpt-6-luna")?.rate).toEqual({ input: 1, write: 2, read: 0, output: 4 });
  expect(Pick.model(Providers.offer(), "openai", "gpt-6.1-sol")?.rate).toBeUndefined();
  expect(Providers.get("openai").models[0].rate).toBeUndefined();
});

test("no pick set: the first connected model", () => {
  expect(Providers.picks().pick).toEqual({ vendor: "openai", model: "gpt-6-luna", effort: "medium", speed: "slow" });
  expect(Providers.picks().compactor).toEqual({ vendor: "openai", model: "gpt-6-luna", effort: "high", speed: "slow" });
  expect(Providers.picks().agents).toBeNull();
  expect(Providers.picks().lost).toEqual([]);
});

test("no compactor set: the first connected provider's cheapest priced model", () => {
  config.SECRETS.set("ANTHROPIC_API_KEY", "test");
  expect(Providers.picks().pick.model).toBe("opus-5.5");
  expect(Providers.picks().compactor).toEqual({ vendor: "anthropic", model: "haiku-5.5", effort: "high" });
  config.SECRETS.set("ANTHROPIC_API_KEY", "");
});

test("the picks follow the providers connected now; with none, the last made stay", () => {
  config.SECRETS.set("ANTHROPIC_API_KEY", "test");
  expect(Providers.picks().compactor.vendor).toBe("anthropic");
  config.SECRETS.set("ANTHROPIC_API_KEY", "");
  expect(Providers.picks().pick.vendor).toBe("openai");
  expect(Providers.picks().compactor.vendor).toBe("openai");
  config.SECRETS.set("OPENAI_API_KEY", "");
  expect(Providers.picks().pick.vendor).toBe("openai");
  config.SECRETS.set("OPENAI_API_KEY", "test");
});

test("picks set but not connected give way, and each is told", () => {
  process.env.KAZUKI_PICK      = "anthropic:sonnet-5.5:medium:slow";
  process.env.KAZUKI_COMPACTOR = "anthropic:haiku-5.5:high:slow";
  process.env.KAZUKI_AGENTS    = "anthropic:opus-5.5:high:slow";
  expect(Providers.picks().pick.vendor).toBe("openai");
  expect(Providers.picks().compactor.vendor).toBe("openai");
  expect(Providers.picks().agents).toBeNull();
  expect(Providers.picks().lost).toEqual([
    "pick anthropic:sonnet-5.5:medium:slow isn't connected, so new chats run on openai:gpt-6-luna:medium:slow.",
    "compactor anthropic:haiku-5.5:high:slow isn't connected, so summaries run on openai:gpt-6-luna:high:slow.",
    "agents anthropic:opus-5.5:high:slow isn't connected, so agents run on the chat's pick.",
  ]);
  delete process.env.KAZUKI_PICK;
  delete process.env.KAZUKI_COMPACTOR;
  delete process.env.KAZUKI_AGENTS;
  expect(Providers.picks().lost).toEqual([]);
});

test("a pick naming no model is an error", () => {
  process.env.KAZUKI_PICK = "anthropic:sonet-5.5:medium:slow";
  expect(why()).toBe("Model not found: anthropic:sonet-5.5. Check your config (pick) provider:model names.");
  process.env.KAZUKI_PICK = "openai:gpt-6-luna:medium:quick";
  expect(why()).toBe("config: pick is no provider:model[:effort][:speed]: openai:gpt-6-luna:medium:quick");
  delete process.env.KAZUKI_PICK;
});

test("config models naming no connected model is its own error", () => {
  const run = Bun.spawnSync([process.execPath, "-e", `
    const config = await import("./Config.ts");
    const { Plugin } = await import("./Plugin.ts");
    const { Providers } = await import("./Provider.ts");
    Plugin.load();
    const got = config.config_picks(Providers.offer(), Providers.catalog());
    console.log(got.ok ? "" : got.error().message);
  `], { cwd: import.meta.dir, env: { ...process.env, KAZUKI_MODELS: "opus-5.5", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "test" }, stdout: "pipe" });
  expect(run.stdout.toString()).toContain("Model not found: opus-5.5. Check your config (models) model names");
});

test("a pick's effort and speed may be left out, in either order", () => {
  process.env.KAZUKI_PICK = "openai:gpt-6-luna";
  expect(Providers.picks().pick).toEqual({ vendor: "openai", model: "gpt-6-luna", effort: "medium", speed: "slow" });
  process.env.KAZUKI_PICK = "openai:gpt-6-luna:fast:high";
  expect(Providers.picks().pick).toEqual({ vendor: "openai", model: "gpt-6-luna", effort: "high", speed: "fast" });
  process.env.KAZUKI_PICK = "openai:gpt-6-luna:high:ultrafast";
  expect(Providers.picks().pick.speed).toBe("fast");
  expect(Providers.picks().lost).toEqual([]);
  delete process.env.KAZUKI_PICK;
});

test("a provider runs on the method chosen, never on another one", () => {
  const openai = Providers.get("openai");
  fs.writeFileSync(config.CHATGPT, JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }));
  expect(Providers.active(openai)?.type).toBe("key");
  Providers.choose("openai", "oauth", true);
  expect(Providers.active(openai)?.type).toBe("oauth");
  fs.rmSync(config.CHATGPT);
  expect(Providers.active(openai)).toBeUndefined();
  Providers.choose("openai", "key", false);
  expect(Providers.active(openai)).toBeUndefined();
  Providers.choose("openai", "oauth", false);
  expect(Providers.active(openai)?.type).toBe("key");
  expect(Providers.chosen()).toEqual({});
});

test("a provider id is added once", () => {
  expect(() => Providers.add(Providers.get("openai"))).toThrow("provider openai is added twice");
});

test("a sign-in file without its tokens connects nothing", () => {
  config.SECRETS.set("OPENAI_API_KEY", "");
  fs.writeFileSync(config.CHATGPT, "{}");
  expect(Plugin.ready()).toBe(false);
  fs.writeFileSync(config.CHATGPT, "not json");
  expect(Plugin.ready()).toBe(false);
  fs.writeFileSync(config.CHATGPT, JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }));
  expect(Providers.active(Providers.get("openai"))?.type).toBe("oauth");
  fs.rmSync(config.CHATGPT);
});

test("with none connected, the server doesn't start", () => {
  config.SECRETS.set("OPENAI_API_KEY", "");
  expect(Plugin.ready()).toBe(false);
});

test("the keys leave the environment once read, and go back only to workers", () => {
  config.SECRETS.clear();
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.APNS_KEY       = "apns-test";
  config.config_hide(Providers.envs());
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
  expect(process.env.APNS_KEY).toBeUndefined();
  expect(config.secret("OPENAI_API_KEY")).toBe("sk-test");
  expect(config.config_env().OPENAI_API_KEY).toBe("sk-test");
  expect(config.config_env().APNS_KEY).toBe("apns-test");
});

test("a call names its model as the method used names it", () => {
  const model = { label: "m", id: "key-m", name: "M", speeds: ["slow"] };
  const signin: OAuth = { type: "oauth", name: "S", signed: () => true, login: async () => new Ok(), logout: async () => new Ok(""), models: [{ ...model, id: "signin-m" }] };
  Providers.add({ ...Providers.get("openai"), id: "fake", models: [model], auth: [signin] });
  expect(Providers.ask({ vendor: "fake", model: "m", effort: "medium", speed: "slow" }).model).toBe("signin-m");
});

test("a ping says why a connected provider fails, and that one not connected isn't", async () => {
  const real = globalThis.fetch;
  let status = 400;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status })) as any;
  try {
    const why = async (id: string) => {
      const got = await Plugin.ping(Providers.get(id));
      return got.ok ? "" : got.error().message;
    };
    expect(await why("openai")).toBe("HTTP 400: bad key");
    status = 401;
    expect(await why("openai")).toBe("Provider authentication failed (openai): bad key");
    expect(await why("anthropic")).toBe("not connected");
  } finally {
    globalThis.fetch = real;
  }
});

test("voice bills only a key chosen: with the ChatGPT sign-in chosen, it refuses", async () => {
  const { OpenAI } = await import("./OpenAI.ts");
  Providers.choose("openai", "oauth", true);
  try {
    const got = await OpenAI.transcribe(new Blob(["x"], { type: "audio/webm" }));
    expect(got.ok ? "" : got.error().message).toContain("Voice needs openai on OPENAI_API_KEY");
  } finally {
    Providers.choose("openai", "oauth", false);
  }
});
