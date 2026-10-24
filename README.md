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

The design is in the header comment of each file. Start with `Memory.ts` (the
tree and the view), `Server.ts` (the chat, turns, workers), and `AskAI.ts`
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
bun build --compile Term.ts --outfile kazuki
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
ChatGPT provider sign-in is separate: run `./kazuki chatgpt`.

To run the source server for a browser instead:

```sh
bun Server.ts                    # http://127.0.0.1:8788, data in ~/.kazuki
```

Then open <http://127.0.0.1:8788>. `bun Term.ts help` lists the rest.

The server is loopback-only: it accepts `127.0.0.1`, `localhost`, and `::1`
hosts and same-origin browser requests. Do not put it behind a reverse proxy
or expose it publicly without access controls; it has no application login or
session authentication. Model-provider credentials remain required.

Other commands:

```sh
bun run test                     # the tests, each file on its own
bun run web                      # rebuild web/app.js from web/src
bun build --compile Term.ts --outfile kazuki
```

Your chats live in `~/.kazuki/users/<id>`, one JSON line per message (`main/`)
and per summary (`tree/`). They are the memory: back them up.

## Config

`~/.kazuki/config.json` is optional (the directory is `$KAZUKI_DIR`). Each
key may also be set as `KAZUKI_<KEY>`:

- `site`: the server's local origin (default `http://127.0.0.1:8788`). Another
  port: `KAZUKI_SITE=http://127.0.0.1:9000 bun Server.ts 9000`.
- `vendors`: what the server offers, comma-separated: `claude-api` (default),
  `openai-api`, `openai-sub` (a ChatGPT plan, below).
- `models`: the models offered, by label (`Pick.ts`; default all).
- `pick`: what a chat runs on until it picks another,
  `vendor:model:effort:speed` (default `claude-api:sonnet-5.5:medium:slow`).
- `compactor`: what writes the summaries (default
  `claude-api:haiku-5.5:high:slow`).
- `agents`: what subagents run on (default: the chat's pick).
- `work`: the agents' working directories on each device (default
  `~/.kazuki/work`).
- `rules`: a file appended to every system prompt.
- `after`: a shell command run after each turn.
- `workers`: how many processes serve the local users (default none: one
  process). With a number, `Server.ts` only routes, behind a proxy that honors
  its `x-kazuki-worker` header (`Server.ts` explains).
- `apple`, `apns`: the iOS app's App ID and push key ID (`ios/`).
- `chatgpt`: where the ChatGPT sign-in is kept (default
  `~/.kazuki/chatgpt.json`).

Keys are read from the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
and `APNS_KEY`.

With only an OpenAI key, set `vendors`, `pick`, and `compactor` to
`openai-api` models, for example:

```sh
KAZUKI_VENDORS=openai-api \
KAZUKI_PICK=openai-api:gpt-6.1-sol:medium:slow \
KAZUKI_COMPACTOR=openai-api:gpt-6-luna:high:slow \
bun Server.ts
```

With a ChatGPT plan instead, run `kazuki chatgpt` (or `bun ChatGPT.ts`; it
shows a link and a code to enter in any browser; `logout` signs out) and use
`openai-sub` the same way. The sign-in is local to the server that uses it.

## The `kazuki` terminal

`install.sh` downloads the latest release's archive for this platform, checks
it against the release's `SHA256SUMS`, and installs it to `~/.local/bin/kazuki`;
with no published release it stops. Each release's assets also carry a GitHub
build provenance attestation, which `gh attestation verify <archive> --repo
lovexbytes/kazuki` checks. `kazuki` alone starts and opens its local
server; `kazuki <url>` is client-only for another local instance.

Run with `KAZUKI_COMPUTER=1` on a Mac and the agent may use its screen (it
compiles `Computer.swift` with `swiftc`; macOS asks for Screen Recording and
Accessibility).

## Credits and license

Kazuki is an independent local-only fork of
[Victor Taelin's UniiChat](https://github.com/VictorTaelin/uniichat), created
at Higher Order Company. Upstream work is attributed under the Apache-2.0
license; see [LICENSE](LICENSE). Kazuki is not affiliated with or a hosted
service of the upstream project or Higher Order Company.
