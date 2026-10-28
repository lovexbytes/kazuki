// Preload
// =======
// Loaded before the server in an end-to-end run (`bun --preload
// test/e2e/preload.ts src/cli.ts serve …`, kit.ts): refuses every request
// to a host that is not this computer, so a run can never reach a real
// API or the internet. The vendors' addresses point at the fakes
// (auth.json, kit.ts); one missed is refused here, and the run fails.

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/
const real = globalThis.fetch

globalThis.fetch = ((input: any, init?: any) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  if (!LOCAL.test(url)) {
    return Promise.reject(new Error(`e2e: blocked a request to ${url}`))
  }
  return real(input, init)
}) as typeof fetch
