#!/bin/sh
# env
# ===
# A clean environment for an end-to-end run: `test/e2e/env.sh <command…>`.
# Nothing of the caller's environment passes but PATH and TERM, so no
# real key or KAZUKI_* setting leaks in. HOME, KAZUKI_DIR and KAZUKI_WORK
# point into $E2E (default: a fresh temporary folder), never ~/.kazuki.
# The mock and the server run on two free ports (never 8788), so runs in
# other worktrees can go on at the same time.

E2E=${E2E:-$(mktemp -d "${TMPDIR:-/tmp}/kazuki-e2e.XXXXXX")}
mkdir -p "$E2E/home"
PORTS=$(bun -e 'const s = [0, 0].map(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })); console.log(s.map((x) => x.port).join(" ")); s.forEach((x) => x.stop(true))')
exec env -i \
  PATH="$PATH" TERM="${TERM:-xterm-256color}" \
  E2E="$E2E" E2E_LOG="$E2E/mock.jsonl" E2E_MOCK="http://127.0.0.1:${PORTS% *}" \
  HOME="$E2E/home" \
  KAZUKI_DIR="$E2E/home/.kazuki" \
  KAZUKI_WORK="$E2E/home/work" \
  KAZUKI_URL="http://127.0.0.1:${PORTS#* }" \
  KAZUKI_MODELS_FETCH="off" \
  ANTHROPIC_API_KEY="e2e-anthropic-dummy" \
  OPENAI_API_KEY="e2e-openai-dummy" \
  "$@"
