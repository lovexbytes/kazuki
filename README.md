# Kazuki

Kazuki is a fork of [UniiChat](https://github.com/VictorTaelin/uniichat) by
Victor Taelin. We plan to develop it independently.

**This repo is vibe-coded.** AI agents wrote nearly all of it, and AI
agents reviewed it. Read it, run it and fork it as such: expect bugs.

Kazuki is a local-first AI agent with one chat that never ends. There is no
"new chat" button: you talk to the same agent for days, weeks, years, and it
remembers. It runs on your computer with your model-provider credentials; this
repository does not operate a hosted service.

## How it works

- **One chat, a memory tree.** Every message is summarized into one line,
  and neighboring lines are merged in pairs, again and again, into a binary
  tree. Each call sees a view of the whole chat, up to 128 KB: recent messages
  one line each, older ones covered by fewer, broader lines. Detail fades with
  age, but nothing is lost.
- **Zoom.** The agent can open any line into the two it was made from, down to
  the original message. So its context never rots, and it never needs a
  "compaction" that throws the past away.
- **Built in the background.** Summaries are written by a cheaper model (the
  compactor) as messages arrive. The view changes only at its end, so each
  call reads most of its input from the vendor's prompt cache.
- **Every window is a view.** The local server owns the chat. A browser tab,
  or `kazuki` in a terminal, shows it live; any of them can send a message,
  stop the work, or change the model.
- **Agents and tools.** The agent runs a shell, reads and edits files, and can
  drive a Mac's screen on a computer where `kazuki` is open. It can spawn
  subagents, which work in the background and report back as messages.
- **Import.** Bring your past Claude and ChatGPT chats (Claude Code and Codex
  folders, or the websites' exports); they join the tree.

The design is in the header comment of each file. Start with `memory.ts` (the
tree and the view), `server.ts` (the chat, turns, workers), and `ask-ai.ts`
(model calls and the cache).

## Run it

Install a verified release without Git, Node, or a preinstalled Bun:

```sh
curl -fsSL https://raw.githubusercontent.com/lovexbytes/kazuki/main/install.sh | sh
```

This installs `kazuki` to `~/.local/bin/kazuki`.

You need an Anthropic API key (or an OpenAI one, below) to run a local chat.
To build from source instead, install [Bun](https://bun.sh) >= 1.4.3:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
bun install
bun scripts/build.ts --outfile kazuki
./kazuki
```

`./kazuki` starts its loopback server when none is already listening, then
opens the same persistent local chat. `./kazuki server` starts it in the
background, `./kazuki tui` opens only the terminal UI, and `./kazuki web`
starts it and opens its URL in a browser. The background server stays up when
the TUI exits; use `/quit` or empty Ctrl+D to leave the TUI. Its output is in
`$KAZUKI_DIR/server.log` (default `~/.kazuki/server.log`). Set
`KAZUKI_URL=http://127.0.0.1:9000` (and `KAZUKI_SITE` if it is not already
set) for another local port; `localhost` and `[::1]` aliases resolve to its
IPv4 loopback listener. `./kazuki http://example.test` is client-only.
Kazuki starts only with a provider connected: `./kazuki auth` lists them and
connects one.

To run the source server for a browser instead:

```sh
bun src/core/server.ts                    # http://127.0.0.1:8788, data in ~/.kazuki
```

Then open <http://127.0.0.1:8788>. `bun src/cli.ts help` lists the rest.

The server is loopback-only: it accepts `127.0.0.1`, `localhost`, and `::1`
hosts and same-origin browser requests. Do not put it behind a reverse proxy
or expose it publicly without access controls; it has no application login or
session authentication. Model-provider credentials remain required.

Other commands:

```sh
bun run test                     # the tests, each file on its own
bun run web                      # rebuild web/app.js from web/src
bun scripts/build.ts --outfile kazuki    # the executable (--target=bun-linux-x64 ...)
bun src/cli.ts tui                  # the terminal UI from source
```

Run `bun src/cli.ts` from the repository root: Bun reads `bunfig.toml` (the
terminal UI's JSX transform) only from the current directory.

## The terminal

`kazuki` in a terminal is a client of the server, as a browser tab is: it
connects by the server's socket (`view.ts`), and any server it can reach will
do (`kazuki http://host:port`). It is built on
[OpenTUI](https://github.com/anomalyco/opentui) (Solid), in `src/tui/`:
`client.ts` (the link, and the agent's jobs this device runs), `app.tsx` (the
page), `transcript.tsx` (the chat), `tool.tsx` (each tool call: a command and
its output, a file read, a write's or edit's diff, the agents spawned),
`prompt.tsx` (the input, its `/` commands and history). There is one chat, so
there are no sessions to manage: older messages show as the memory tree's
summaries, opened by a click, and each subagent at work is a tab (Tab).

Your chats live in `~/.kazuki/users/<id>`, one JSON line per message (`main/`)
and per summary (`tree/`). They are the memory: back them up.

## Config

`~/.kazuki/config.json` is optional (the directory is `$KAZUKI_DIR`). Each
key may also be set as `KAZUKI_<KEY>`:

- `site`: the server's local origin (default `http://127.0.0.1:8788`). Another
  port: `KAZUKI_SITE=http://127.0.0.1:9000 bun src/core/server.ts 9000`.
- `models`: the models offered, by label, comma-separated (default all).
- `pick`: what a chat runs on until it picks another,
  `provider:model[:effort][:speed]`, the effort and speed only for a
  model that has them (default: the first connected model; set
  but not connected: that too, and every view that opens is told so, as
  for `compactor` and `agents`).
- `compactor`: what writes the summaries (default: the cheapest model of
  the first connected provider, by models.dev's output price; for
  Anthropic, Haiku).
- `agents`: what subagents run on (default: the chat's pick).

These follow the providers connected now: if one disconnects while the
server runs, the defaults move to a connected model at once, a chat on
it moves at its next turn and says so, and every open view is told.
- `work`: the agents' working directories on each device (default
  `~/.kazuki/work`).
- `rules`: a file appended to every system prompt.
- `after`: a shell command run after each turn.
- `workers`: how many processes serve the local users (default none: one
  process). With a number, `server.ts` only routes, behind a proxy that honors
  its `x-kazuki-worker` header (`server.ts` explains).
- `apple`, `apns`: the iOS app's App ID and push key ID (`ios/`).
- `chatgpt`: where the ChatGPT sign-in is kept (default
  `~/.kazuki/chatgpt.json`).
- `models_fetch`: `off` stops the fetch of the models' prices from
  models.dev every 5 minutes (`models-dev.ts`); the picker then shows the
  last copy kept (`~/.kazuki/models.json`) or the one Kazuki ships
  (`models.txt`, made again with `bun src/ai/models-dev.ts`).

## Providers

Each provider is a plugin (`plugin.ts`, `provider.ts`). The server offers
only the connected ones, and won't start with none. `kazuki auth` lists
them, and sends each connected one a small request to check that it
works: it shows as connected only if it answers (each check costs a
fraction of a cent):

- `anthropic`: set `ANTHROPIC_API_KEY`.
- `openai`: set `OPENAI_API_KEY`, or sign in with a ChatGPT plan:
  `kazuki auth openai login` (or `kazuki chatgpt`, or `bun src/ai/chatgpt.ts`)
  shows a link and a code to enter in any browser; `kazuki auth openai
  logout` signs out. The sign-in is local to the server that uses it.
  Voice messages need openai on its key (`kazuki auth openai use key`):
  a ChatGPT sign-in has no transcription.

A provider runs on the method chosen: a sign-in chooses itself, and
`kazuki auth <id> use key` (or `use oauth`) chooses. A chosen method
that stops working disconnects the provider; it never falls back to
another one that bills elsewhere. With none chosen, the first method set
up is used (for openai, the key). The choice is in `~/.kazuki/auth.json`.

Keys are read from the environment when the server starts, with
`APNS_KEY`, and removed from it.

## The `kazuki` terminal

`install.sh` downloads the latest release's archive for this platform, checks
it against the release's `SHA256SUMS`, and installs it to `~/.local/bin/kazuki`;
with no published release it stops. Each release's assets also carry a GitHub
build provenance attestation, which `gh attestation verify <archive> --repo
lovexbytes/kazuki` checks. `kazuki` alone starts and opens its local
server; `kazuki <url>` is client-only for another local instance.

Run with `KAZUKI_COMPUTER=1` on a Mac and the agent may use its screen (it
compiles `computer.swift` with `swiftc`; macOS asks for Screen Recording and
Accessibility).

## Credits and license

Kazuki is an independent local-only fork of
[Victor Taelin's UniiChat](https://github.com/VictorTaelin/uniichat), created
at Higher Order Company. Upstream work is attributed under the Apache-2.0
license; see [LICENSE](LICENSE). Kazuki is not affiliated with or a hosted
service of the upstream project or Higher Order Company.
