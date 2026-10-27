// ChatGPT auth
// ============
// `kazuki auth openai login` (or `kazuki chatgpt`, or
// `bun src/ai/chatgpt.ts`) signs in as Codex's OAuth client, by a device code typed at auth.openai.com/codex/device (no
// redirect back to this computer: the server is often another). The
// tokens go to FILE (config `chatgpt`), in Codex's auth.json shape,
// mode 600. Each request reads FILE; the access token is refreshed 5
// min before it expires and once on a 401, one refresh at a time in a
// process. A refresh refused as used reads FILE again for a while
// (another process refreshed it), as Codex does; one saves only if FILE
// still holds the tokens it refreshed (a logout or sign-in since wins).

import * as fs from "node:fs"
import * as path from "node:path"
import {Providers} from "./provider.ts"
import * as config from "../config.ts"
import {caught, Err, Ok, type Result} from "../util/result.ts"

// Types
// =====

export type Tokens = {
  id_token: string
  access_token: string
  refresh_token: string
  account_id: string
}

// FILE, as Codex writes its auth.json
export type Auth = {
  auth_mode: "chatgpt"
  OPENAI_API_KEY: null
  tokens: Tokens
  last_refresh: string
}

// Constants
// =========

// Codex CLI's OAuth client
// biome-ignore lint/security/noSecrets: the sign-in's public client id, not a secret
const CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = config
  .config_get("chatgpt_issuer", "https://auth.openai.com")
  .replace(/\/$/, "")

// how close to its expiry a token is refreshed; how old a token with no
// expiry may get; the longest a request to the issuer takes; how long a
// sign-in waits for its user to enter its device code; how long
// a refresh refused as used waits for another process's tokens (ms)
const EARLY = 5 * 60e3
const OLD = 8 * 86_400e3
const REQUEST = 20e3
const DEVICE = 15 * 60e3
const SETTLE = 2e3

// the claim with a token's account
export const CLAIMS = "https://api.openai.com/auth"

// refresh errors that only signing in again fixes
const GONE = [
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "invalid_grant"
]

const SIGN_IN =
  "sign in again: `kazuki chatgpt` (or `bun src/ai/chatgpt.ts`) on the server"

// the refresh under way in this process, which every call waits on
let REFRESHING: Promise<Result<Auth, Error>> | null = null

// ChatGPT
// =======

export namespace ChatGPTAuth {
  // Tokens
  // ------

  // a JWT's claims ({}: not one)
  export function claims(jwt: string): any {
    try {
      return (
        JSON.parse(
          Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")
        ) ?? {}
      )
    } catch {
      return {}
    }
  }

  export function json(text: string): any {
    try {
      return JSON.parse(text) ?? {}
    } catch {
      return {}
    }
  }

  // FILE's sign-in (null: none); a file not JSON, or without its tokens,
  // fails
  export function load(): Result<Auth | null, Error> {
    try {
      if (!fs.existsSync(config.CHATGPT)) {
        return new Ok(null)
      }
      const auth = JSON.parse(fs.readFileSync(config.CHATGPT, "utf8"))
      if (
        typeof auth?.tokens?.access_token !== "string" ||
        typeof auth.tokens.refresh_token !== "string"
      ) {
        return new Err(new Error(`${config.CHATGPT} holds no ChatGPT sign-in`))
      }
      return new Ok(auth)
    } catch (e) {
      return caught(e)
    }
  }

  // whether FILE holds a sign-in: a file that fails holds none
  export function held(): boolean {
    const auth = ChatGPTAuth.load()
    return auth.ok && auth.value() !== null
  }

  // written whole (a temp file renamed over it), owner only, its dir made
  export function save(auth: Auth): Result<void, Error> {
    try {
      fs.mkdirSync(path.dirname(config.CHATGPT), {recursive: true, mode: 0o700})
      const tmp = `${config.CHATGPT}.${process.pid}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, {mode: 0o600})
      fs.renameSync(tmp, config.CHATGPT)
    } catch (e) {
      return caught(e)
    }
    return new Ok()
  }

  // a sign-in from a token response (old: the tokens it refreshed)
  export function auth(got: any, old?: Tokens): Auth {
    const id_token = got.id_token ?? old?.id_token ?? ""
    const tokens: Tokens = {
      id_token,
      access_token: got.access_token,
      refresh_token: got.refresh_token ?? old?.refresh_token,
      account_id:
        ChatGPTAuth.claims(id_token)[CLAIMS]?.chatgpt_account_id ??
        old?.account_id ??
        ""
    }
    return {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens,
      last_refresh: new Date().toISOString()
    }
  }

  // whether it is refreshed now
  export function due(auth: Auth, now = Date.now()): boolean {
    const exp = ChatGPTAuth.claims(auth.tokens.access_token).exp
    return typeof exp === "number"
      ? exp * 1000 <= now + EARLY
      : !(Date.parse(auth.last_refresh) > now - OLD)
  }

  // the access token a request sends, refreshed if due or if it is the
  // one a 401 refused (agent.ts Wire auth)
  export async function token(
    refused?: string
  ): Promise<Result<string, Error>> {
    const got = ChatGPTAuth.load()
    if (!got.ok) {
      return new Err(got.error())
    }
    const auth = got.value()
    if (auth === null) {
      return new Err(new Error(`not signed in to ChatGPT: ${SIGN_IN}`))
    }
    if (auth.tokens.access_token !== refused && !ChatGPTAuth.due(auth)) {
      return new Ok(auth.tokens.access_token)
    }
    REFRESHING ??= ChatGPTAuth.refresh(auth).finally(() => {
      REFRESHING = null
    })
    const fresh = await REFRESHING
    return fresh.ok
      ? new Ok(fresh.value().tokens.access_token)
      : new Err(fresh.error())
  }

  // an error that asking again may get past: a busy try (agent.ts)
  export function busy(why: string): Error {
    return Object.assign(new Error(`ChatGPT token refresh failed: ${why}`), {
      busy: true
    })
  }

  // as Codex asks it (its fields only); refused for good, FILE read again
  // for SETTLE ms: another process's new tokens, if it writes some. Saved
  // only if FILE still holds `old`'s, else FILE's sign-in is the one used
  export async function refresh(old: Auth): Promise<Result<Auth, Error>> {
    // FILE's sign-in if another refreshed it (null: still old's)
    const newer = (): Result<Auth | null, Error> => {
      const now = ChatGPTAuth.load()
      if (!now.ok) {
        return now
      }
      const auth = now.value()
      if (auth === null) {
        return new Err(new Error(`signed out of ChatGPT: ${SIGN_IN}`))
      }
      return new Ok(
        auth.tokens.refresh_token === old.tokens.refresh_token ? null : auth
      )
    }
    let res: Response
    let text: string
    try {
      res = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          client_id: CLIENT,
          grant_type: "refresh_token",
          refresh_token: old.tokens.refresh_token
        }),
        signal: AbortSignal.timeout(REQUEST)
      })
      text = await res.text()
    } catch (e) {
      return new Err(ChatGPTAuth.busy(caught(e).error().message))
    }
    const body = ChatGPTAuth.json(text)
    if (!res.ok) {
      const code = String(
        typeof body.error === "string"
          ? body.error
          : (body.error?.code ?? body.code ?? "")
      ).toLowerCase()
      if (res.status !== 401 && !GONE.includes(code)) {
        return new Err(ChatGPTAuth.busy(`HTTP ${res.status}`))
      }
      for (const end = Date.now() + SETTLE; ; await Bun.sleep(250)) {
        const now = newer()
        if (!now.ok) {
          return new Err(now.error())
        }
        const auth = now.value()
        if (auth !== null) {
          return new Ok(auth)
        }
        if (Date.now() >= end) {
          break
        }
      }
      return new Err(
        new Error(
          "the ChatGPT sign-in has expired or was revoked (" +
            (code || `HTTP ${res.status}`) +
            "): " +
            SIGN_IN
        )
      )
    }
    if (typeof body.access_token !== "string") {
      return new Err(ChatGPTAuth.busy("no access token"))
    }
    const auth = ChatGPTAuth.auth(body, old.tokens)
    const now = newer()
    if (!now.ok) {
      return new Err(now.error())
    }
    const theirs = now.value()
    if (theirs !== null) {
      return new Ok(theirs)
    }
    const saved = ChatGPTAuth.save(auth)
    return saved.ok ? new Ok(auth) : new Err(saved.error())
  }

  // Sign-in
  // -------

  // an authorization code's tokens, saved
  export async function exchange(
    code: string,
    redirect: string,
    verifier: string
  ): Promise<Result<Auth, Error>> {
    try {
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT,
        code,
        redirect_uri: redirect,
        code_verifier: verifier
      })
      const res = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: {"content-type": "application/x-www-form-urlencoded"},
        body: form,
        signal: AbortSignal.timeout(REQUEST)
      })
      const text = await res.text()
      if (!res.ok) {
        return new Err(
          new Error(
            "ChatGPT sign-in failed: HTTP " +
              res.status +
              ": " +
              text.slice(0, 300)
          )
        )
      }
      const auth = ChatGPTAuth.auth(JSON.parse(text))
      const saved = ChatGPTAuth.save(auth)
      return saved.ok ? new Ok(auth) : new Err(saved.error())
    } catch (e) {
      return caught(e)
    }
  }

  // by a device code: the link and code to show, then polling till the
  // user entered it, within `wait` ms; a poll the issuer fails (5xx, no
  // answer) polls on
  export async function device(
    show: (url: string, code: string) => void,
    wait = DEVICE
  ): Promise<Result<Auth, Error>> {
    const api = `${ISSUER}/api/accounts/deviceauth`
    const post = (path: string, body: object) =>
      fetch(api + path, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST)
      })
    try {
      const res = await post("/usercode", {client_id: CLIENT})
      if (!res.ok) {
        const off =
          res.status === 404
            ? " (device code sign-in is off for this account: allow it in ChatGPT's security settings)"
            : ""
        return new Err(
          new Error(
            `ChatGPT device code request failed: HTTP ${res.status}${off}`
          )
        )
      }
      const got: any = await res.json()
      const code = got.user_code ?? got.usercode
      const every = Math.max(1, Number(got.interval) || 5) * 1000
      show(`${ISSUER}/codex/device`, code)
      for (
        const end = Date.now() + wait;
        Date.now() < end;
        await Bun.sleep(Math.min(every, end - Date.now()))
      ) {
        const poll = await post("/token", {
          device_auth_id: got.device_auth_id,
          user_code: code
        }).catch(() => null)
        if (poll?.ok) {
          const ok: any = await poll.json()
          return ChatGPTAuth.exchange(
            ok.authorization_code,
            `${ISSUER}/deviceauth/callback`,
            ok.code_verifier
          )
        }
        if (
          poll !== null &&
          poll.status !== 403 &&
          poll.status !== 404 &&
          poll.status < 500
        ) {
          return new Err(
            new Error(`ChatGPT device sign-in failed: HTTP ${poll.status}`)
          )
        }
      }
      return new Err(
        new Error(
          "ChatGPT device sign-in timed out after " +
            Math.round(wait / 60e3) +
            " minutes"
        )
      )
    } catch (e) {
      return caught(e)
    }
  }

  // revokes the refresh token (Codex's logout), then forgets the sign-in
  // whether or not that worked (one in a file that fails to load has no
  // token to revoke). The choice stays: openai isn't
  // connected till another is chosen, so it never moves to a key that
  // bills
  export async function logout(): Promise<Result<string, Error>> {
    const got = ChatGPTAuth.load()
    const auth = got.ok ? got.value() : null
    if (got.ok && auth === null) {
      return new Ok("Not signed in to ChatGPT.")
    }
    const res =
      auth === null
        ? null
        : await fetch(`${ISSUER}/oauth/revoke`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
              token: auth.tokens.refresh_token,
              token_type_hint: "refresh_token",
              client_id: CLIENT
            }),
            signal: AbortSignal.timeout(REQUEST)
          }).catch(() => null)
    try {
      fs.rmSync(config.CHATGPT, {force: true})
    } catch (e) {
      return caught(e)
    }
    const note =
      Providers.chosen().openai === "oauth"
        ? " To run openai on OPENAI_API_KEY: `kazuki auth openai use key`."
        : ""
    const why =
      auth === null
        ? "it held no token"
        : res
          ? `HTTP ${res.status}`
          : "offline"
    return new Ok(
      "Signed out of ChatGPT" +
        (res?.ok ? "." : ` (its token wasn't revoked: ${why}).`) +
        note
    )
  }

  // who FILE is signed in as
  export function who(auth: Auth): string {
    const id = ChatGPTAuth.claims(auth.tokens.id_token)
    const plan = id[CLAIMS]?.chatgpt_plan_type
    return (id.email ?? "an account") + (plan ? ` (${plan} plan)` : "")
  }

  // `kazuki chatgpt [logout]`
  export async function cli(args: string[]): Promise<Result<void, Error>> {
    if (args.includes("logout")) {
      const out = await ChatGPTAuth.logout()
      if (!out.ok) {
        return new Err(out.error())
      }
      console.log(out.value())
      return new Ok()
    }
    const got = await ChatGPTAuth.device((url, code) =>
      console.log(
        "To sign this server in to ChatGPT, open\n\n  " +
          url +
          "\n\nand enter the code\n\n  " +
          code +
          "\n\n(it expires in 15 minutes; enter it only if you started this sign-in)"
      )
    )
    if (!got.ok) {
      return new Err(got.error())
    }
    const chose = Providers.choose("openai", "oauth", true)
    if (!chose.ok) {
      return new Err(chose.error())
    }
    console.log(
      "\nSigned in to ChatGPT as " +
        ChatGPTAuth.who(got.value()) +
        "; tokens in " +
        config.CHATGPT +
        ". openai now runs on it."
    )
    return new Ok()
  }
}
