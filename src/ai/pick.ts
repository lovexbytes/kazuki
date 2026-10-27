// Pick
// ====
// What a chat's calls run on, kept in its log: a vendor (a provider's
// id: provider.ts), a model of its, and its effort and speed if the
// model has them (one without has none to pick); label
// vendor:model[:effort][:speed]. What may be picked is the offer: the
// connected providers' catalogs, which the server sends (no table here,
// so a plugin's provider is picked like any). A chat that saved none
// takes the config's (`def`). A move steps one part along the picks
// that differ in it (`options`), wrapping (up and down stop at the
// ends): next, prev and model every vendor's models, effort, speed,
// up and down the efforts, never the speed; given a value (`to`), to the
// pick whose part it is. A pick on a model lacking its effort or speed
// takes the model's nearest below, else its lowest (`on`).
// A model two providers offer (two plugins with one label) is two picks
// of the same label, shown alike (its vendor in the hint: `twin`): a move
// by value takes the pick's own vendor's, or the one named
// "vendor:model". A saved pick the server doesn't offer gives way to
// def, never to a pick like it.

import type {Vendor} from "./ask-ai.ts"
import type {Rate} from "./price.ts"

// Types
// =====

// model: by its label
export type Pick = {
  vendor: Vendor
  model: string
  effort?: string
  speed?: string
}

// a key's change to the pick
export type Move =
  | "next"
  | "prev"
  | "model"
  | "up"
  | "down"
  | "effort"
  | "speed"

// a model: its label (in a pick), its id (as the vendor names it), its
// name (as a person reads it), its efforts and speeds (none: no choice)
// and list prices
export type Model = {
  label: string
  id: string
  name: string
  efforts?: string[]
  speeds?: string[]
  rate?: Rate
}

// a provider as a client sees it: no code, only what may be picked
export type Catalog = {id: Vendor; name: string; models: Model[]}

// what a server offers: its connected providers' catalogs
export type Offer = Catalog[]

// Constants
// =========

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

export const SPEEDS = ["slow", "fast", "ultrafast"]

// Pick
// ====

export namespace Pick {
  export function model(
    offer: Offer,
    vendor: Vendor,
    label: string
  ): Model | undefined {
    return offer
      .find((p) => p.id === vendor)
      ?.models.find((m) => m.label === label)
  }

  // the pick on this model, its effort and speed the model's
  export function on(pick: Pick, vendor: Vendor, model: Model): Pick {
    const effort = Pick.near(EFFORTS, model.efforts, pick.effort ?? "medium")
    const speed = Pick.near(SPEEDS, model.speeds, pick.speed ?? "slow")
    return {vendor, model: model.label, effort, speed}
  }

  // of a model's values (none: none), the one wanted or the nearest below
  // it in `all`, else its lowest
  export function near(
    all: string[],
    has: string[] | undefined,
    want: string
  ): string | undefined {
    if (has === undefined) {
      return undefined
    }
    return (
      all
        .slice(0, all.indexOf(want) + 1)
        .filter((x) => has.includes(x))
        .pop() ?? has[0]
    )
  }

  // the one of the lowest output price (unpriced: the dearest); a tie,
  // the first
  export function cheapest(models: Model[]): Model {
    const out = (m: Model) => m.rate?.output ?? Number.POSITIVE_INFINITY
    return models.reduce((a, b) => (out(b) < out(a) ? b : a))
  }

  // the models offered, each with its vendor
  export function models(offer: Offer): [Vendor, Model][] {
    return offer.flatMap((p) => p.models.map((m): [Vendor, Model] => [p.id, m]))
  }

  // each with the part the move steps
  export function options(
    pick: Pick,
    move: Move,
    offer: Offer
  ): [string, Pick][] {
    const model = Pick.model(offer, pick.vendor, pick.model)
    switch (move) {
      case "next":
      case "prev":
      case "model": {
        return Pick.models(offer).map(([v, m]): [string, Pick] => [
          m.label,
          Pick.on(pick, v, m)
        ])
      }
      case "up":
      case "down":
      case "effort": {
        return (model?.efforts ?? []).map((effort) => [
          effort,
          {...pick, effort}
        ])
      }
      case "speed": {
        return (model?.speeds ?? []).map((speed) => [speed, {...pick, speed}])
      }
    }
  }

  export function move(
    pick: Pick,
    move: Move,
    offer: Offer,
    to?: string
  ): Pick | null {
    const list = Pick.options(pick, move, offer)
    const n = list.length
    const at = list.findIndex(([, p]) => Pick.label(p) === Pick.label(pick))
    const d = move === "prev" || move === "down" ? -1 : 1
    const ends = move === "up" || move === "down"
    const next = ends ? Math.max(0, Math.min(n - 1, at + d)) : (at + d + n) % n
    const mine = ([, p]: [string, Pick]) => p.vendor === pick.vendor
    const same = list.filter(
      ([part, p]) => part === to || `${p.vendor}:${part}` === to
    )
    const like = list.filter(([part]) =>
      part.toLowerCase().includes(String(to).toLowerCase())
    )
    const one =
      like.length === 1
        ? like[0]
        : like.filter(mine).length === 1
          ? like.find(mine)
          : undefined
    const hit =
      to === undefined ? list[next] : (same.find(mine) ?? same[0] ?? one)
    return hit === undefined ? null : hit[1]
  }

  // whether another vendor offered has a model of this label
  export function twin(vendor: Vendor, label: string, offer: Offer): boolean {
    return offer.some(
      (p) => p.id !== vendor && p.models.some((m) => m.label === label)
    )
  }

  export function label(pick: Pick): string {
    return [pick.vendor, pick.model, pick.effort, pick.speed]
      .filter((x) => x !== undefined)
      .join(":")
  }

  // as the chat runs it, on its model (`on`); null: none
  export function read(x: any, offer: Offer): Pick | null {
    const model = Pick.model(offer, x?.vendor, x?.model)
    const known = (all: string[], v: unknown) =>
      v === undefined || all.includes(v as string)
    if (
      model === undefined ||
      !known(EFFORTS, x.effort) ||
      !known(SPEEDS, x.speed)
    ) {
      return null
    }
    return Pick.on(
      {vendor: x.vendor, model: x.model, effort: x.effort, speed: x.speed},
      x.vendor,
      model
    )
  }

  // the pick saved (the chat's log keeps it: memory.ts) if offered, else
  // def (Config makes it an offered one)
  export function load(saved: object | null, offer: Offer, def: Pick): Pick {
    return Pick.read(saved ?? def, offer) ?? def
  }
}
