// ChatGPT
// =======
// Sign in with ChatGPT: an auth method of the openai provider
// (Provider.ts, Plugin.ts), a ChatGPT plan instead of an API key,
// signed in and called as Codex CLI does (openai/codex: codex-rs login,
// codex-api). Used, it runs openai's models on its own wire, without
// ultrafast nor list prices (the plan pays). `kazuki auth openai login`
// (or `kazuki chatgpt`, or `bun ChatGPT.ts`) signs in as Codex's OAuth
// client, by a device code typed at auth.openai.com/codex/device (no
// redirect back to this computer: the server is often another). The
// tokens go to FILE (config `chatgpt`), in Codex's auth.json shape,
// mode 600. Each request reads FILE; the access token is refreshed 5
// min before it expires and once on a 401, one refresh at a time in a
// process. A refresh refused as used reads FILE again for a while
// (another process refreshed it), as Codex does; one saves only if FILE
// still holds the tokens it refreshed (a logout or sign-in since wins).
// The body is Codex's: openai's parts (OpenAI.ts), the system prompt
// as `instructions`, no max_output_tokens. A usage limit (429) is told to
// the user as such, with its reset time (Agent.ts, AskAI.ts).
// config `chatgpt_issuer` and `chatgpt_url` point it elsewhere (tests).

import * as fs from "node:fs";
import * as path from "node:path";
import type { Ask } from "./AskAI.ts";
import type { Emit, Item, Refusal, Tool, Wire } from "./Agent.ts";
import { MODELS, OpenAI, type State } from "./OpenAI.ts";
import { Providers, type OAuth } from "./Provider.ts";
import * as config from "./Config.ts";
import { caught, Err, Ok, type Result } from "./Result.ts";

// Types
// =====

export type Tokens = { id_token: string; access_token: string; refresh_token: string; account_id: string };

// FILE, as Codex writes its auth.json
export type Auth = { auth_mode: "chatgpt"; OPENAI_API_KEY: null; tokens: Tokens; last_refresh: string };

// a stream read so far, the items it gave
type Sub = State & { items: any[] };

// Constants
// =========

// Codex CLI's OAuth client
const CLIENT    = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER    = config.config_get("chatgpt_issuer", "https://auth.openai.com").replace(/\/$/, "");
const RESPONSES = config.config_get("chatgpt_url", "https://chatgpt.com/backend-api/codex").replace(/\/$/, "") + "/responses";

// how close to its expiry a token is refreshed; how old a token with no
// expiry may get; the longest a request to the issuer takes; how long a
// sign-in waits for its user to enter its device code; how long
// a refresh refused as used waits for another process's tokens (ms)
const EARLY   = 5 * 60e3;
const OLD     = 8 * 86400e3;
const REQUEST = 20e3;
const DEVICE  = 15 * 60e3;
const SETTLE  = 2e3;

// the claim with a token's account
const CLAIMS = "https://api.openai.com/auth";

// refresh errors that only signing in again fixes
const GONE = ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant"];

// 429s whose limit lasts, and what the user reads of each
const LIMITS: Record<string, string> = {
  usage_limit_reached : "reached its usage limit",
  usage_not_included  : "doesn't include this use",
  insufficient_quota  : "is out of quota",
};

const SIGN_IN = "sign in again: `kazuki chatgpt` (or `bun ChatGPT.ts`) on the server";

// the refresh under way in this process, which every call waits on
let REFRESHING: Promise<Result<Auth, Error>> | null = null;

// ChatGPT
// =======

export namespace ChatGPT {

  // Tokens
  // ------

  // a JWT's claims ({}: not one)
  export function claims(jwt: string): any {
    try {
      return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) ?? {};
    } catch {
      return {};
    }
  }

  export function json(text: string): any {
    try {
      return JSON.parse(text) ?? {};
    } catch {
      return {};
    }
  }

  // FILE's sign-in (null: none); a file not JSON, or without its tokens,
  // fails
  export function load(): Result<Auth | null, Error> {
    try {
      if (!fs.existsSync(config.CHATGPT)) {
        return new Ok(null);
      }
      const auth = JSON.parse(fs.readFileSync(config.CHATGPT, "utf8"));
      if (typeof auth?.tokens?.access_token !== "string" || typeof auth.tokens.refresh_token !== "string") {
        return new Err(new Error(config.CHATGPT + " holds no ChatGPT sign-in"));
      }
      return new Ok(auth);
    } catch (e) {
      return caught(e);
    }
  }

  // whether FILE holds a sign-in: a file that fails holds none
  export function held(): boolean {
    const auth = ChatGPT.load();
    return auth.ok && auth.value() !== null;
  }

  // written whole (a temp file renamed over it), owner only, its dir made
  export function save(auth: Auth): Result<void, Error> {
    try {
      fs.mkdirSync(path.dirname(config.CHATGPT), { recursive: true, mode: 0o700 });
      const tmp = config.CHATGPT + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, config.CHATGPT);
    } catch (e) {
      return caught(e);
    }
    return new Ok();
  }

  // a sign-in from a token response (old: the tokens it refreshed)
  export function auth(got: any, old?: Tokens): Auth {
    const id_token = got.id_token ?? old?.id_token ?? "";
    const tokens: Tokens = {
      id_token,
      access_token  : got.access_token,
      refresh_token : got.refresh_token ?? old?.refresh_token,
      account_id    : ChatGPT.claims(id_token)[CLAIMS]?.chatgpt_account_id ?? old?.account_id ?? "",
    };
    return { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens, last_refresh: new Date().toISOString() };
  }

  // whether it is refreshed now
  export function due(auth: Auth, now = Date.now()): boolean {
    const exp = ChatGPT.claims(auth.tokens.access_token).exp;
    return typeof exp === "number" ? exp * 1000 <= now + EARLY : !(Date.parse(auth.last_refresh) > now - OLD);
  }

  // the access token a request sends, refreshed if due or if it is the
  // one a 401 refused (Agent.ts Wire auth)
  export async function token(refused?: string): Promise<Result<string, Error>> {
    const got = ChatGPT.load();
    if (!got.ok) {
      return new Err(got.error());
    }
    const auth = got.value();
    if (auth === null) {
      return new Err(new Error("not signed in to ChatGPT: " + SIGN_IN));
    }
    if (auth.tokens.access_token !== refused && !ChatGPT.due(auth)) {
      return new Ok(auth.tokens.access_token);
    }
    REFRESHING ??= ChatGPT.refresh(auth).finally(() => (REFRESHING = null));
    const fresh = await REFRESHING;
    return fresh.ok ? new Ok(fresh.value().tokens.access_token) : new Err(fresh.error());
  }

  // an error that asking again may get past: a busy try (Agent.ts)
  export function busy(why: string): Error {
    return Object.assign(new Error("ChatGPT token refresh failed: " + why), { busy: true });
  }

  // as Codex asks it (its fields only); refused for good, FILE read again
  // for SETTLE ms: another process's new tokens, if it writes some. Saved
  // only if FILE still holds `old`'s, else FILE's sign-in is the one used
  export async function refresh(old: Auth): Promise<Result<Auth, Error>> {
    // FILE's sign-in if another refreshed it (null: still old's)
    const newer = (): Result<Auth | null, Error> => {
      const now = ChatGPT.load();
      if (!now.ok) {
        return now;
      }
      const auth = now.value();
      if (auth === null) {
        return new Err(new Error("signed out of ChatGPT: " + SIGN_IN));
      }
      return new Ok(auth.tokens.refresh_token !== old.tokens.refresh_token ? auth : null);
    };
    let res: Response;
    let text: string;
    try {
      res = await fetch(ISSUER + "/oauth/token", {
        method  : "POST",
        headers : { "content-type": "application/json" },
        body    : JSON.stringify({ client_id: CLIENT, grant_type: "refresh_token", refresh_token: old.tokens.refresh_token }),
        signal  : AbortSignal.timeout(REQUEST),
      });
      text = await res.text();
    } catch (e) {
      return new Err(ChatGPT.busy(caught(e).error().message));
    }
    const body = ChatGPT.json(text);
    if (!res.ok) {
      const code = String(typeof body.error === "string" ? body.error : body.error?.code ?? body.code ?? "").toLowerCase();
      if (res.status !== 401 && !GONE.includes(code)) {
        return new Err(ChatGPT.busy("HTTP " + res.status));
      }
      for (const end = Date.now() + SETTLE; ; await Bun.sleep(250)) {
        const now = newer();
        if (!now.ok) {
          return new Err(now.error());
        }
        const auth = now.value();
        if (auth !== null) {
          return new Ok(auth);
        }
        if (Date.now() >= end) {
          break;
        }
      }
      return new Err(new Error("the ChatGPT sign-in has expired or was revoked (" + (code || "HTTP " + res.status) + "): " + SIGN_IN));
    }
    if (typeof body.access_token !== "string") {
      return new Err(ChatGPT.busy("no access token"));
    }
    const auth = ChatGPT.auth(body, old.tokens);
    const now = newer();
    if (!now.ok) {
      return new Err(now.error());
    }
    const theirs = now.value();
    if (theirs !== null) {
      return new Ok(theirs);
    }
    const saved = ChatGPT.save(auth);
    return saved.ok ? new Ok(auth) : new Err(saved.error());
  }

  // Sign-in
  // -------

  // an authorization code's tokens, saved
  export async function exchange(code: string, redirect: string, verifier: string): Promise<Result<Auth, Error>> {
    try {
      const form = new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code, redirect_uri: redirect, code_verifier: verifier });
      const res = await fetch(ISSUER + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(REQUEST) });
      const text = await res.text();
      if (!res.ok) {
        return new Err(new Error("ChatGPT sign-in failed: HTTP " + res.status + ": " + text.slice(0, 300)));
      }
      const auth = ChatGPT.auth(JSON.parse(text));
      const saved = ChatGPT.save(auth);
      return saved.ok ? new Ok(auth) : new Err(saved.error());
    } catch (e) {
      return caught(e);
    }
  }

  // by a device code: the link and code to show, then polling till the
  // user entered it, within `wait` ms; a poll the issuer fails (5xx, no
  // answer) polls on
  export async function device(show: (url: string, code: string) => void, wait = DEVICE): Promise<Result<Auth, Error>> {
    const api = ISSUER + "/api/accounts/deviceauth";
    const post = (path: string, body: object) =>
      fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST) });
    try {
      const res = await post("/usercode", { client_id: CLIENT });
      if (!res.ok) {
        const off = res.status === 404 ? " (device code sign-in is off for this account: allow it in ChatGPT's security settings)" : "";
        return new Err(new Error("ChatGPT device code request failed: HTTP " + res.status + off));
      }
      const got: any = await res.json();
      const code = got.user_code ?? got.usercode;
      const every = Math.max(1, Number(got.interval) || 5) * 1000;
      show(ISSUER + "/codex/device", code);
      for (const end = Date.now() + wait; Date.now() < end; await Bun.sleep(Math.min(every, end - Date.now()))) {
        const poll = await post("/token", { device_auth_id: got.device_auth_id, user_code: code }).catch(() => null);
        if (poll?.ok) {
          const ok: any = await poll.json();
          return ChatGPT.exchange(ok.authorization_code, ISSUER + "/deviceauth/callback", ok.code_verifier);
        }
        if (poll !== null && poll.status !== 403 && poll.status !== 404 && poll.status < 500) {
          return new Err(new Error("ChatGPT device sign-in failed: HTTP " + poll.status));
        }
      }
      return new Err(new Error("ChatGPT device sign-in timed out after " + Math.round(wait / 60e3) + " minutes"));
    } catch (e) {
      return caught(e);
    }
  }

  // revokes the refresh token (Codex's logout), then forgets the sign-in
  // whether or not that worked (one in a file that fails to load has no
  // token to revoke). The choice stays: openai isn't
  // connected till another is chosen, so it never moves to a key that
  // bills
  export async function logout(): Promise<Result<string, Error>> {
    const got = ChatGPT.load();
    const auth = got.ok ? got.value() : null;
    if (got.ok && auth === null) {
      return new Ok("Not signed in to ChatGPT.");
    }
    const res = auth === null ? null : await fetch(ISSUER + "/oauth/revoke", {
      method  : "POST",
      headers : { "content-type": "application/json" },
      body    : JSON.stringify({ token: auth.tokens.refresh_token, token_type_hint: "refresh_token", client_id: CLIENT }),
      signal  : AbortSignal.timeout(REQUEST),
    }).catch(() => null);
    try {
      fs.rmSync(config.CHATGPT, { force: true });
    } catch (e) {
      return caught(e);
    }
    const note = Providers.chosen().openai === "oauth" ? " To run openai on OPENAI_API_KEY: `kazuki auth openai use key`." : "";
    const why = auth === null ? "it held no token" : res ? "HTTP " + res.status : "offline";
    return new Ok("Signed out of ChatGPT" + (res?.ok ? "." : " (its token wasn't revoked: " + why + ").") + note);
  }

  // who FILE is signed in as
  export function who(auth: Auth): string {
    const id = ChatGPT.claims(auth.tokens.id_token);
    const plan = id[CLAIMS]?.chatgpt_plan_type;
    return (id.email ?? "an account") + (plan ? " (" + plan + " plan)" : "");
  }

  // `kazuki chatgpt [logout]`
  export async function cli(args: string[]): Promise<Result<void, Error>> {
    if (args.includes("logout")) {
      const out = await ChatGPT.logout();
      if (!out.ok) {
        return new Err(out.error());
      }
      console.log(out.value());
      return new Ok();
    }
    const got = await ChatGPT.device((url, code) => console.log("To sign this server in to ChatGPT, open\n\n  " + url + "\n\nand enter the code\n\n  " + code + "\n\n(it expires in 15 minutes; enter it only if you started this sign-in)"));
    if (!got.ok) {
      return new Err(got.error());
    }
    const chose = Providers.choose("openai", "oauth", true);
    if (!chose.ok) {
      return new Err(chose.error());
    }
    console.log("\nSigned in to ChatGPT as " + ChatGPT.who(got.value()) + "; tokens in " + config.CHATGPT + ". openai now runs on it.");
    return new Ok();
  }

  // Wire
  // ----

  // the body Codex sends, its fields in its order, of openai's parts:
  // the system prompt as `instructions` (the backend requires it), no
  // max_output_tokens, cache breakpoints nor tool-call cap
  export function body(ask: Ask, items: Item[], tools: Tool[], max: number): unknown {
    const api: any = OpenAI.body({ ...ask, speed: "slow" }, items, tools, max);
    return {
      model               : api.model,
      instructions        : ask.system,
      input               : api.input.slice(1).map(ChatGPT.unmark),
      tools               : api.tools,
      tool_choice         : "auto",
      parallel_tool_calls : true,
      reasoning           : api.reasoning,
      store               : false,
      stream              : true,
      include             : ["reasoning.encrypted_content"],
      service_tier        : ask.speed === "fast" ? "priority" : undefined,
      prompt_cache_key    : "kazuki-" + Bun.hash(JSON.stringify([ask.model, ask.system, ask.blocks[0]?.text ?? ""])).toString(36),
    };
  }

  // a user message without its cache breakpoints
  export function unmark(item: any): any {
    if (item.role !== "user" || !Array.isArray(item.content)) {
      return item;
    }
    return { ...item, content: item.content.map(({ prompt_cache_breakpoint, ...part }: any) => part) };
  }

  export function headers(token: string): Record<string, string> {
    const saved = ChatGPT.load();
    return {
      authorization        : "Bearer " + token,
      "chatgpt-account-id" : ChatGPT.claims(token)[CLAIMS]?.chatgpt_account_id ?? (saved.ok ? saved.value()?.tokens.account_id : undefined) ?? "",
      "openai-beta"        : "responses=experimental",
      "content-type"       : "application/json",
      accept               : "text/event-stream",
      originator           : "kazuki",
    };
  }

  // one stream event, as OpenAI.read takes it; the backend's last
  // response holds no output, so its output is the items streamed
  export function read(st: Sub, ev: any, on: Emit): boolean {
    if (ev.type === "response.output_item.done") {
      st.items[ev.output_index ?? st.items.length] = ev.item;
    }
    const end = OpenAI.read(st, ev, on);
    if (end && st.res !== null && !(st.res.output?.length > 0)) {
      st.res = { ...st.res, output: st.items.filter(Boolean) };
    }
    return end;
  }

  // a 429 at a lasting limit (null: not one): the backend's words logged,
  // ours said (which limit, the plan, when it resets)
  export function refusal(res: Response, text: string): Refusal | null {
    const err = ChatGPT.json(text).error ?? {};
    const kind = [err.type, err.code].find((k) => typeof k === "string" && Object.hasOwn(LIMITS, k));
    if (res.status !== 429 || kind === undefined) {
      return null;
    }
    const until = typeof err.resets_at === "number" && err.resets_at > 0 && err.resets_at < 1e11 ? err.resets_at * 1000 : undefined;
    const plan = typeof err.plan_type === "string" && /^[a-z0-9_]{1,20}$/.test(err.plan_type) ? " (" + err.plan_type + ")" : "";
    const when = until === undefined ? "" : "; it resets " + new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const why = "ChatGPT " + kind + plan + when + ": " + String(err.message ?? "").slice(0, 300);
    return { why, say: "the ChatGPT plan" + plan + " this server runs on " + LIMITS[kind] + when, until };
  }

  export const wire: Wire<Sub> = {
    idle    : 1200e3,
    url     : RESPONSES,
    auth    : (refused) => ChatGPT.token(refused),
    headers : (token) => ChatGPT.headers(token),
    body    : (ask, items, tools, max) => ChatGPT.body(ask, items, tools, max),
    start   : (ask) => ({ ...OpenAI.wire.start(ask), items: [] }),
    read    : (st, ev, on) => ChatGPT.read(st, ev, on),
    begun   : (ev) => ev.type === "response.output_item.added",
    step    : (st, ask) => ({ ...OpenAI.step(st, ask), note: "" }),
    refusal : (res, text) => ChatGPT.refusal(res, text),
  };

  export const signin: OAuth = {
    type   : "oauth",
    name   : "ChatGPT Plus/Pro",
    signed : () => ChatGPT.held(),
    login  : () => ChatGPT.cli([]),
    logout : () => ChatGPT.logout(),
    wire   : ChatGPT.wire,
    models : MODELS.map((m) => ({ ...m, speeds: m.speeds?.filter((s) => s !== "ultrafast") })),
    ttl    : 300e3, // the backend tells none: the shorter guess
  };

}

if (import.meta.main) {
  const got = await ChatGPT.cli(process.argv.slice(2));
  if (!got.ok) {
    console.error(got.error().message);
    process.exit(1);
  }
}
