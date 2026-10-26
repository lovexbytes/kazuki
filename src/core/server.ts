#!/usr/bin/env bun
// Server
// ======
// The agent: chats that never end (memory.ts), one per user signed in
// (cloud.ts), at config.DIR/users/<id>, and their views, terminals
// (src/cli.ts) and browser tabs (web/), each one WebSocket (view.ts's Link)
// carrying the chat's events and its acts (one with a body: a post to
// /api/act), each done once (Views.apply), within USERS' limit. A
// terminal's socket names its device, which the agent's tools reach
// (tools.ts) until it quits.
//
// One turn at a time. A message is logged as it arrives; the running call
// takes it between tool calls if it goes whole beside its view, else the
// next call does, on the chat's pick (pick.ts). One nobody views is let
// go.
//
// Alone, this process serves the site. Workers (config.WORKERS, behind a
// proxy: README) each serve the users shard() gives them, under this
// process (Main.supervise), which only routes. A deploy is a handover:
// told so (SIGHUP), the supervisor starts each worker anew beside the
// old one, on the same port; the old one takes no more connections and
// gives the new one each chat once no post of it runs (Move.give): its
// work goes on there, the calls it runs (its turn's, agents', summaries')
// going on where they started, fed straight to where the chat is (Main.away,
// Main.far), and its views open again there at once (view.ts MOVE). It
// ends once those calls do (a process that ran none, at once). A stop or
// crash cuts all: a start resumes what ran (Chat.wake), told so.
//
// Usage: server.ts [port]   (127.0.0.1; default 8788)

import { NONE, Plugin } from "./plugin.ts";
import { Providers } from "../ai/provider.ts";
import { ModelsDev } from "../ai/models-dev.ts";
import * as config from "../config.ts";
import { LOST } from "./server/shared.ts";
import { Main } from "./server/main.ts";

export { Chat } from "./server/chat.ts";
export { Ingest } from "./server/ingest.ts";
export { Move } from "./server/move.ts";
export { Views } from "./server/views.ts";
export { Main } from "./server/main.ts";

// run: the command that starts this server again, to start a worker
// (null: the server is one process: no workers, or `kazuki serve`)
export async function serve(port: number, run: string[] | null): Promise<void> {
  // the plugins first: they name the providers, the picks offered and the
  // secrets to hide
  if (!Plugin.ready()) {
    console.error(NONE);
    process.exitCode = 1;
    return;
  }
  const picks = config.config_picks(Providers.offer(), Providers.catalog());
  if (!picks.ok) {
    console.error("kazuki: " + picks.error().message);
    process.exitCode = 1;
    return;
  }
  LOST.told = Providers.picks().lost;
  LOST.told.forEach((text) => console.error("kazuki: config: " + text));
  config.config_hide(Providers.envs());
  const worker = process.env.KAZUKI_WORKER;
  Main.count = run === null ? 1 : config.WORKERS;
  Main.index = Number(worker ?? 0);
  if (worker === undefined) {
    await Main.lock();
  }
  // one fetch for the machine: the lock's holder's
  ModelsDev.watch(worker === undefined);
  if (worker === undefined && run !== null) {
    Main.supervise(port, run);
  } else {
    await Main.start(port);
  }
}

if (import.meta.main) {
  await serve(Number(process.argv[2] ?? 8788), config.WORKERS > 0 ? [process.execPath, import.meta.path] : null);
}
