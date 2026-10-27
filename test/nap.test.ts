// Nap test
// ========
// `bun test nap.test.ts`. A nap leaves no listener on its signal, however
// it ends.

import {expect, test} from "bun:test"
import {nap} from "../src/util/nap.ts"

// a signal that counts the abort listeners on it
function counted(): {ctl: AbortController; on: () => number} {
  const ctl = new AbortController()
  let n = 0
  const add = ctl.signal.addEventListener.bind(ctl.signal)
  const remove = ctl.signal.removeEventListener.bind(ctl.signal)
  ctl.signal.addEventListener = ((type: string, fn: any, opts?: any) => {
    n += 1
    return add(type, fn, opts)
  }) as any
  ctl.signal.removeEventListener = ((type: string, fn: any, opts?: any) => {
    n -= 1
    return remove(type, fn, opts)
  }) as any
  return {ctl, on: () => n}
}

test("a nap that times out takes its listener off", async () => {
  const {ctl, on} = counted()
  await Promise.all([
    nap(1, ctl.signal),
    nap(1, ctl.signal),
    nap(1, ctl.signal)
  ])
  expect(on()).toBe(0)
})

test("a nap ends at once on an abort", async () => {
  const {ctl, on} = counted()
  const at = Date.now()
  const slept = nap(60e3, ctl.signal)
  ctl.abort()
  await slept
  expect(Date.now() - at).toBeLessThan(1000)
  expect(on()).toBe(0)
})
