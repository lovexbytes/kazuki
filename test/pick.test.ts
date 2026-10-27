// Pick test
// =========
// `bun test pick.test.ts`. Moves along an offer of two providers that
// share a label: next wraps across providers, a speed the next model
// lacks steps down, up and down stop at the ends, a move by value takes
// the pick's own provider's or the one named "vendor:model", a pick the
// offer doesn't have reads as none, and a model with no effort or speed
// has none to pick.

import {expect, test} from "bun:test"
import {EFFORTS, Pick, type Offer} from "../src/ai/pick.ts"

const OFFER: Offer = [
  {
    id: "a",
    name: "A",
    models: [
      {
        label: "m1",
        id: "a-m1",
        name: "M1",
        efforts: EFFORTS,
        speeds: ["slow", "fast"]
      }
    ]
  },
  {
    id: "b",
    name: "B",
    models: [
      {label: "m1", id: "b-m1", name: "M1", efforts: EFFORTS, speeds: ["slow"]},
      {label: "m2", id: "b-m2", name: "M2", efforts: EFFORTS, speeds: ["slow"]}
    ]
  },
  {
    id: "c",
    name: "C",
    models: [
      {label: "plain", id: "c-plain", name: "Plain"},
      {label: "few", id: "c-few", name: "Few", efforts: ["low", "high"]}
    ]
  }
]

const P: Pick = {vendor: "a", model: "m1", effort: "medium", speed: "fast"}

test("next and prev wrap across providers; a speed lacked steps down", () => {
  expect(Pick.move(P, "next", OFFER)).toEqual({
    vendor: "b",
    model: "m1",
    effort: "medium",
    speed: "slow"
  })
  expect(
    Pick.move({...P, vendor: "b", model: "m2", speed: "slow"}, "prev", OFFER)
  ).toEqual({vendor: "b", model: "m1", effort: "medium", speed: "slow"})
  expect(Pick.move(P, "prev", OFFER)?.model).toBe("few")
  expect(
    Pick.move(
      {...P, vendor: "c", model: "few", effort: "low", speed: undefined},
      "next",
      OFFER
    )?.vendor
  ).toBe("a")
})

test("up and down stop at the ends; speed steps the model's own", () => {
  expect(Pick.move({...P, effort: "max"}, "up", OFFER)?.effort).toBe("max")
  expect(Pick.move({...P, effort: "low"}, "down", OFFER)?.effort).toBe("low")
  expect(Pick.move(P, "speed", OFFER)?.speed).toBe("slow")
  expect(Pick.options(P, "speed", OFFER).map(([s]) => s)).toEqual([
    "slow",
    "fast"
  ])
})

test("a move by value: the pick's own provider's, or the one named", () => {
  expect(Pick.move(P, "model", OFFER, "m1")?.vendor).toBe("a")
  expect(Pick.move(P, "model", OFFER, "b:m1")?.vendor).toBe("b")
  expect(Pick.move(P, "model", OFFER, "m2")).toEqual({
    vendor: "b",
    model: "m2",
    effort: "medium",
    speed: "slow"
  })
  expect(Pick.move(P, "model", OFFER, "zz")).toBeNull()
  expect(Pick.move(P, "effort", OFFER, "high")?.effort).toBe("high")
})

test("twins and reads", () => {
  expect(Pick.twin("a", "m1", OFFER)).toBe(true)
  expect(Pick.twin("b", "m2", OFFER)).toBe(false)
  expect(Pick.read(P, OFFER)).toEqual(P)
  expect(Pick.read({...P, model: "zz"}, OFFER)).toBeNull()
  expect(Pick.read({...P, vendor: "b"}, OFFER)?.speed).toBe("slow")
  expect(Pick.read({...P, effort: "huge"}, OFFER)).toBeNull()
  expect(Pick.load({...P, vendor: "gone"}, OFFER, P)).toEqual(P)
  expect(Pick.load(null, OFFER, P)).toEqual(P)
})

test("a model with no effort or speed has none to pick; one lacking the effort asked steps down", () => {
  const plain = Pick.move(P, "model", OFFER, "plain")!
  expect(plain).toEqual({
    vendor: "c",
    model: "plain",
    effort: undefined,
    speed: undefined
  })
  expect(Pick.label(plain)).toBe("c:plain")
  expect(Pick.options(plain, "effort", OFFER)).toEqual([])
  expect(Pick.options(plain, "speed", OFFER)).toEqual([])
  expect(Pick.move(plain, "up", OFFER)).toBeNull()
  expect(Pick.read({...P, vendor: "c", model: "plain"}, OFFER)).toEqual(plain)
  expect(
    Pick.read({...P, vendor: "c", model: "few", effort: "max"}, OFFER)?.effort
  ).toBe("high")
  expect(
    Pick.read({...P, vendor: "c", model: "few", effort: "medium"}, OFFER)
      ?.effort
  ).toBe("low")
  expect(Pick.read({vendor: "a", model: "m1"}, OFFER)).toEqual({
    vendor: "a",
    model: "m1",
    effort: "medium",
    speed: "slow"
  })
})
