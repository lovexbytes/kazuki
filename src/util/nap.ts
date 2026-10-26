// Nap
// ===
// An abortable sleep, used by model retries and device waits.

// ms, or till the signal aborts: none, if it already did (an abort
// event comes once). Either end takes the listener off, so naps on one
// long-lived signal (a chat's) leave nothing behind
export function nap(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((ok) => {
    const end = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
      ok();
    };
    const timer = setTimeout(end, signal.aborted ? 0 : ms);
    signal.addEventListener("abort", end, { once: true });
  });
}
