// Preload
// =======
// Loaded before Kazuki (`bun --preload test/e2e/preload.ts src/cli.ts …`): sends
// the vendors' hosts to the mock (test/e2e/mock.ts at $E2E_MOCK), and refuses
// every other host that is not this computer, so an end-to-end run can
// never reach a real API or the internet.

const MOCK  = process.env.E2E_MOCK ?? "http://127.0.0.1:9711";
const HOSTS = ["https://api.anthropic.com", "https://api.openai.com"];
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/;
const real  = globalThis.fetch;

globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = HOSTS.find((h) => url.startsWith(h));
  if (host !== undefined) {
    return real(MOCK + url.slice(host.length), init);
  }
  if (!LOCAL.test(url)) {
    return Promise.reject(new Error("e2e: blocked a request to " + url));
  }
  return real(input, init);
}) as typeof fetch;
