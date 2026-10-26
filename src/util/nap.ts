// Nap
// ===
// An abortable sleep, used by model retries and device waits.

// ms, or till the signal aborts: none, if it already did (an abort
// event comes once)
export function nap(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((ok) => {
    const timer = setTimeout(ok, signal.aborted ? 0 : ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      ok();
    });
  });
}
