// Billing
// =======
// All a server does for money, behind one boundary: Billing.open gives
// the server's billing, which the local chat holds (Cloud.ts), and no other
// file knows what it is. It says whether the server bills (`bills`:
// /api/hello, /api/me, /api/account and each chat's state carry it, and
// no client shows a price, a balance or a payment where it is false), what
// a chat may spend, and the payer each of
// its paid requests asks right before it is sent (AskAI.ts Bill).
//
// This one is FREE: the server runs on its own API keys. The local account
// needs no creation or sign-in, no request waits for a payer, nothing
// is owed, and no route but the accounts' answers. A hosted server plugs
// in a billing of its own with the same shape.

import type { Pay } from "./AskAI.ts";
import type { Cloud, User } from "./Cloud.ts";
import type { Memory } from "./Memory.ts";
import type { Answer } from "./View.ts";

// Types
// =====

// what a chat's wallet reads and tells (Server.ts Chat): its user, its
// memory (the sides it holds), its import running (its requests book all
// they may write; what they cost, added), and what to do once it holds a
// side (its state changed) and once a request ends (it may rest)
export type Payee = {
  user  : string;
  mem   : Memory;
  batch : () => { spent: number } | null;
  told  : () => void;
  rest  : () => void;
};

// a chat's wallet: its payer (none: free), the micro-USD its running
// requests booked, and, the credit changed, what ends its work (null:
// nothing)
export type Wallet = {
  pay     : Pay | undefined;
  booked  : () => number;
  changed : () => string | null;
};

// the server's billing: whether it bills; by user, the cents they may spend as last told (below zero: a debt;
// moved with a chat); what is held on a user but their chat; why no money
// may leave their account
// yet (null: none); its closing (why not: a debt, a refusal; null:
// closed), and what that also does, said; its requests (null: none of
// them); its start, as a worker (mine: its users; chats: those loaded);
// a user's balance read; what they may spend (null: free, or not told);
// why they may not spend `usd` (0: anything) now (null: they may); what
// they owe, charged; a chat's wallet
export type Billing = {
  bills   : boolean;
  credit  : Map<string, number>;
  data    : (user: User) => Promise<object>;
  owing   : (user: string) => Promise<string | null>;
  close   : (user: User, req: Request) => Promise<string | null>;
  closes  : string;
  http    : (req: Request, user: User | null) => Promise<Response | null>;
  start   : (worker: number, mine: (user: string) => boolean, chats: Map<string, { socks: Set<unknown> }>) => void;
  balance : (user: string) => Promise<void>;
  credits : (user: string) => number | null;
  refuse  : (user: string, usd: number) => Answer | null;
  settle  : (user: string) => void;
  wallet  : (payee: Payee) => Wallet;
};

// the accounts a billing is of (Cloud.ts, which then holds it)
type Accounts = Omit<Cloud, "billing">;

// Billing
// =======

export namespace Billing {

  // the server's billing: FREE
  export function open(cloud: Accounts): Billing {
    return Billing.free(cloud);
  }

  // a free server's local chat
  export function free(cloud: Accounts): Billing {
    return {
      bills   : false,
      credit  : new Map(),
      data    : async () => ({}),
      owing   : async () => null,
      close   : async () => null,
      closes  : "",
      http    : async () => null,
      start   : () => {},
      balance : async () => {},
      credits : () => null,
      refuse  : () => null,
      settle  : () => {},
      wallet  : () => ({ pay: undefined, booked: () => 0, changed: () => null }),
    };
  }


}
