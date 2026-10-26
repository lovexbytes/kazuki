// Disk
// ====
// Durability by group commit. What the server writes under config.DIR
// goes at once to the OS's cache, so no chat waits on the disk; flushes
// run one at a time, each making durable every write before it began: on
// Linux one syncfs of the disk, as cheap for one file as for thousands,
// by a shell kept for it (Bun has no syncfs); elsewhere an fsync per
// file. A process crash loses nothing; a machine's, about the last
// flush. An act is answered, and a charge sent, only once flushed.

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import type { FileSink } from "bun";
import * as config from "./config.ts";
import { caught, Err, Ok, type Result } from "../util/result.ts";

// Types
// =====

// the shell that flushes: what it reads, what it answered not yet read
type Shell = { stdin: FileSink; out: ReadableStreamDefaultReader<Uint8Array>; got: string };

// Globals
// =======

// the files written since the flush running began, the asks waiting on
// them, the flushes running (null: none), the shell that flushes (null:
// none started, or it ended)
const DIRTY = new Set<string>();
let WAITS: Array<() => void> = [];
let RUN: Promise<void> | null = null;
let SHELL: Shell | null = null;

// Disk
// ====

export namespace Disk {

  // a db the processes share, each waiting its turn to write (the wait
  // set first: the switch to WAL locks too)
  export function db(file: string): Database {
    const db = new Database(file, { create: true });
    db.exec("pragma busy_timeout = 10000; pragma journal_mode = wal; pragma synchronous = normal;");
    return db;
  }

  // a file written: flushed soon; answers once it is
  export function wrote(file: string): Promise<void> {
    DIRTY.add(file);
    return Disk.synced();
  }

  // answers once all written so far is flushed
  export function synced(): Promise<void> {
    if (DIRTY.size === 0) {
      return RUN ?? Promise.resolve();
    }
    const done = new Promise<void>((ok) => WAITS.push(ok));
    RUN ??= Disk.run();
    return done;
  }

  export async function run(): Promise<void> {
    while (DIRTY.size > 0) {
      const files = [...DIRTY];
      const waits = WAITS;
      DIRTY.clear();
      WAITS = [];
      const flushed = await Disk.flush(files);
      if (!flushed.ok) {
        console.error("disk: a flush failed: " + flushed.error().message);
      }
      waits.forEach((ok) => ok());
    }
    RUN = null;
  }

  export async function flush(files: string[]): Promise<Result<void, Error>> {
    if (process.platform !== "linux") {
      return Disk.each(files);
    }
    try {
      const shell = (SHELL ??= Disk.shell());
      shell.stdin.write("\n");
      shell.stdin.flush();
      while (!shell.got.includes("\n")) {
        const got = await shell.out.read();
        // the shell ended (a stop's signal): each file by itself
        if (got.done) {
          SHELL = null;
          return Disk.each(files);
        }
        shell.got += new TextDecoder().decode(got.value);
      }
      const code = shell.got.slice(0, shell.got.indexOf("\n"));
      shell.got = shell.got.slice(code.length + 1);
      return code === "0" ? new Ok() : new Err(new Error("sync -f " + config.DIR + " exited " + code));
    } catch (e) {
      return caught(e);
    }
  }

  // each file synced by itself; the first that fails says why
  export async function each(files: string[]): Promise<Result<void, Error>> {
    const all = await Promise.all(files.map(Disk.fsync));
    return all.find((r) => !r.ok) ?? new Ok();
  }

  export function shell(): Shell {
    const run = 'while read _; do sync -f "$0"; echo $?; done';
    const proc = Bun.spawn(["sh", "-c", run, config.DIR], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    return { stdin: proc.stdin, out: proc.stdout.getReader(), got: "" };
  }

  // a file gone since needs none
  export async function fsync(file: string): Promise<Result<void, Error>> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(file, "r");
      await handle.sync();
      return new Ok();
    } catch (e: any) {
      return e?.code === "ENOENT" ? new Ok() : caught(e);
    } finally {
      await handle?.close();
    }
  }

}
