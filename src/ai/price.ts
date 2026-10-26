// Price
// =====
// A model's list prices (USD per million tokens), as models.dev or its
// provider gives them (Model.rate: provider.ts, models-dev.ts), shown in
// the model picker beside each model (view.ts, src/tui/commands.ts), and a
// speed's factor. Informational only: Kazuki runs on the user's own API
// keys and charges nothing.

// Types
// =====

export type Rate = { input: number; write: number; read: number; output: number };

// Constants
// =========

const SPEEDS: Record<string, number> = { slow: 1, fast: 2, ultrafast: 6 };

// Price
// =====

export namespace Price {

  // a speed's factor
  export function times(speed: string): number {
    return SPEEDS[speed] ?? 1;
  }

}
