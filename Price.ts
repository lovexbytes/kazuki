// Price
// =====
// A model's list prices (2026-10, USD per million tokens), shown in the
// model picker beside each model (View.ts, tui/Commands.ts), and a
// speed's factor. Informational only: Kazuki runs on the user's own API
// keys and charges nothing.

// Types
// =====

type Rate = { input: number; write: number; read: number; output: number };

// Constants
// =========

const RATES: Record<string, Rate> = {
  "claude-opus-5-5"   : { input: 4,   write: 5,    read: 0.2,  output: 20  },
  "claude-sonnet-5-5" : { input: 2,   write: 2.5,  read: 0.1,  output: 10  },
  "claude-haiku-5-5"  : { input: 0.1, write: 0.125, read: 0.01, output: 0.5 },
  "gpt-6-astra"       : { input: 10,  write: 12.5, read: 1,    output: 50  },
  "gpt-6.1-sol"       : { input: 2,   write: 2,    read: 0.1,  output: 10  },
  "gpt-6-luna"        : { input: 0.1, write: 0.1,  read: 0.01, output: 0.5 },
};

const SPEEDS: Record<string, number> = { slow: 1, fast: 2, ultrafast: 6 };

// Price
// =====

export namespace Price {

  // a model's list rates (by its id; undefined: none), a speed's factor
  export function rate(model: string): Rate | undefined {
    return RATES[model];
  }

  export function times(speed: string): number {
    return SPEEDS[speed] ?? 1;
  }

}
