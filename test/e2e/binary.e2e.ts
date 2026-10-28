// Binary
// ======
// The compiled executable (scripts/build.ts): it builds, prints its help,
// and works as a pipe client of a server on fake vendors.

import {expect, test} from "bun:test"
import {open, sh} from "./kit.ts"

const kit = open("binary")
const bin = () => `${kit.dir}/kazuki`

test("executable builds", () => {
  // on a failure, the object shown holds the build's output
  expect(sh(["bun", "scripts/build.ts", "--outfile", bin()])).toMatchObject({
    ok: true
  })
})

test("executable: help", () => {
  expect(sh([bin(), "help"]).out).toContain("Usage: kazuki")
})

test("executable: client runs a tool call", async () => {
  const p = Bun.spawn([bin()], {
    cwd: kit.dir,
    env: kit.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  })
  p.stdin.write("RUN: echo e2e-binary-tool\n")
  p.stdin.end()
  const timer = setTimeout(() => p.kill(), 60e3)
  const out =
    (await new Response(p.stdout).text()) +
    (await new Response(p.stderr).text())
  clearTimeout(timer)
  expect(out).toContain("ran: e2e-binary-tool")
})
