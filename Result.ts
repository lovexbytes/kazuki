// Result
// ======
// What a function that may fail gives back: Ok with its value, or Err
// with the Error (its message is what a person reads). A function that
// calls what throws (fs, fetch, JSON.parse, a process) catches it there
// (`caught`); one that calls a fallible function passes its Err up. A
// function that can't fail gives its value plain, and none (null) is
// no failure. Only a bug throws (a plugin loaded twice, a field of
// undefined), to the catch of what runs it: an act's answer (Server.ts
// Chat.fail), a call's end (AskAI.ts), the process's log. Between
// processes a Result is plain JSON, made again on arrival: an act's
// answer `{ error? }` (View.ts), a call's end (AskAI.End).

interface OkResult<T> {
  readonly ok: true;
  value(): T;
}

interface ErrResult<E> {
  readonly ok: false;
  error(): E;
}

export class Ok<T = void> implements OkResult<T> {
  public ok = true as const;
  private data: T extends void ? never : T;
  constructor(data?: T) {
    this.data = data as T extends void ? never : T;
  }
  value(): T {
    return this.data as T;
  }
}

export class Err<E = unknown> implements ErrResult<E> {
  public ok = false as const;
  private data: E;
  constructor(data: E) {
    this.data = data;
  }
  error(): E {
    return this.data;
  }
}

export type Result<T = void, E = unknown> = OkResult<T> | ErrResult<E>;

// what a catch got, as an Err: JS may throw anything, an Error is kept
// whole (its stack, for the log)
export function caught(e: unknown): Err<Error> {
  return new Err(e instanceof Error ? e : new Error(String(e)));
}
