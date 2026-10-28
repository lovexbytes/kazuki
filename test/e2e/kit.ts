// Kit
// ===
// What each end-to-end file (*.e2e.ts) shares: `open(name)` starts the fake
// vendors (fake.ts) and a Kazuki server from source, behind preload.ts,
// all in the folder $E2E/<name> (default $E2E: a fresh temporary folder).
// Each process Kazuki runs gets an environment made here and nothing of
// the caller's but PATH and TERM, so no real key or KAZUKI_* setting
// leaks in, and HOME is in that folder, never ~/.kazuki. The server's
// port is a free one (never 8788), so runs in other worktrees can go on
// at the same time. As the file ends, it checks that the server sent no
// request to a host that is not this computer.
//
// Run: `task e2e` (bun test, each *.e2e.ts by its path).

import {afterAll, beforeAll} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import {type Fake, fake} from "./fake.ts"
import {noop} from "../../src/util/noop.ts"

export const ROOT = `${import.meta.dir}/../..`

const E2E = process.env.E2E ?? fs.mkdtempSync(`${os.tmpdir()}/kazuki-e2e-`)

export type Kit = {
  dir: string
  url: string
  // the environment of a client: no keys
  env: Record<string, string>
  anthropic: Fake
  openai: Fake
  // the server stopped, then started again
  restart: () => Promise<void>
}

// a file's own fakes and server, ready in its beforeAll
export function open(name: string): Kit {
  const dir = `${E2E}/${name}`
  const kit = {dir} as Kit
  let server: Bun.Subprocess | null = null
  const start = async () => {
    const out = `${dir}/server.out`
    server = Bun.spawn(
      [
        "bun",
        "--preload",
        "./test/e2e/preload.ts",
        "src/cli.ts",
        "serve",
        new URL(kit.url).port
      ],
      {
        cwd: ROOT,
        env: {
          ...kit.env,
          ANTHROPIC_API_KEY: "e2e-anthropic-dummy",
          OPENAI_API_KEY: "e2e-openai-dummy"
        },
        stdout: Bun.file(out),
        stderr: Bun.file(out)
      }
    )
    if (!(await until(() => up(kit.url)))) {
      throw new Error(
        `the server did not start:\n${fs.readFileSync(out, "utf8")}`
      )
    }
  }
  beforeAll(async () => {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(`${dir}/home/.kazuki`, {recursive: true})
    kit.anthropic = fake("anthropic", `${dir}/anthropic.jsonl`)
    kit.openai = fake("openai", `${dir}/openai.jsonl`)
    // the providers call the fakes (provider.ts: Providers.url)
    fs.writeFileSync(
      `${dir}/home/.kazuki/auth.json`,
      JSON.stringify({
        anthropic: {urls: {api: kit.anthropic.url}},
        openai: {urls: {api: kit.openai.url}}
      })
    )
    kit.url = `http://127.0.0.1:${port()}`
    kit.env = {
      PATH: process.env.PATH ?? "",
      TERM: process.env.TERM ?? "xterm-256color",
      HOME: `${dir}/home`,
      KAZUKI_DIR: `${dir}/home/.kazuki`,
      KAZUKI_WORK: `${dir}/home/work`,
      KAZUKI_URL: kit.url,
      KAZUKI_MODELS_FETCH: "off"
    }
    kit.restart = async () => {
      server?.kill()
      await server?.exited
      if (await up(kit.url)) {
        throw new Error("the server did not stop")
      }
      await start()
    }
    await start()
  })
  afterAll(() => {
    server?.kill()
    kit.anthropic.stop()
    kit.openai.stop()
    // preload.ts refuses them, and the server logs each
    const blocked = fs
      .readFileSync(`${dir}/server.out`, "utf8")
      .split("\n")
      .filter((l) => l.includes("e2e: blocked"))
    if (blocked.length > 0) {
      throw new Error(`requests left for a real host:\n${blocked.join("\n")}`)
    }
  })
  return kit
}

// Helpers
// =======

// a free port of this computer
function port(): number {
  const s = Bun.listen({hostname: "127.0.0.1", port: 0, socket: {data: noop}})
  const {port} = s
  s.stop(true)
  return port
}

const up = (url: string) =>
  fetch(`${url}/api/me`).then(
    (r) => r.ok,
    () => false
  )

export async function until(
  what: () => Promise<boolean> | boolean,
  ms = 10e3
): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
    if (await what()) {
      return true
    }
  }
  return false
}

// one pipe client run: the lines sent, what it printed (stdout+stderr)
export async function say(
  kit: Kit,
  lines: string[],
  ms = 60e3
): Promise<string> {
  const proc = Bun.spawn(["bun", "src/cli.ts"], {
    cwd: ROOT,
    env: kit.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  })
  proc.stdin.write(`${lines.join("\n")}\n`)
  proc.stdin.end()
  const timer = setTimeout(() => proc.kill(), ms)
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ])
  clearTimeout(timer)
  await proc.exited
  return out + err
}

export function sh(cmd: string[]): {ok: boolean; out: string} {
  const r = Bun.spawnSync(cmd, {cwd: ROOT, stdout: "pipe", stderr: "pipe"})
  return {ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString()}
}
