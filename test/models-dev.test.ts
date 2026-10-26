// ModelsDev test
// ==============
// `bun test models-dev.test.ts`. The prices from models.dev, its fetch a
// stub: a fresh copy is no fetch, an old one is fetched again and kept,
// a fetch that fails or gives a catalog cut short keeps the prices it
// had, and a copy is fresh for half the period.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/kazuki-models-");
process.env.KAZUKI_DIR = DIR;

const { ModelsDev } = await import("../src/ai/models-dev.ts");

// models.dev's api.json: enough providers, one priced model
const catalog = (input: number, providers = 100) => ({
  ...Object.fromEntries(Array.from({ length: providers - 1 }, (_, i) => ["p" + i, { models: {} }])),
  x: { models: { m: { name: "M", cost: { input, output: 2 } }, free: { name: "F" } } },
});

const FETCHES = { n: 0 };
const serve = (res: () => Response) => {
  globalThis.fetch = (async () => {
    FETCHES.n++;
    return res();
  }) as unknown as typeof fetch;
};

test("an old copy is fetched again and kept; a fresh one is no fetch", async () => {
  serve(() => Response.json(catalog(1)));
  await ModelsDev.refresh();
  expect(FETCHES.n).toBe(1);
  expect(ModelsDev.rate("x", "m")).toEqual({ input: 1, write: 0, read: 0, output: 2 });
  expect(ModelsDev.rate("x", "free")).toBeUndefined();
  expect(ModelsDev.stored()?.body.x.models.free).toBeUndefined();
  await ModelsDev.refresh();
  expect(FETCHES.n).toBe(1);
});

test("a failed fetch, or a catalog cut short, keeps the prices", async () => {
  const old = (body: object) => fs.writeFileSync(DIR + "/models.json", JSON.stringify({ at: 0, body }));
  old(ModelsDev.stored()!.body);
  serve(() => new Response("", { status: 500 }));
  await ModelsDev.refresh();
  expect(ModelsDev.rate("x", "m")?.input).toBe(1);
  serve(() => Response.json(catalog(9, 3)));
  await ModelsDev.refresh();
  expect(ModelsDev.rate("x", "m")?.input).toBe(1);
  expect(ModelsDev.stored()?.at).toBe(0);
});

test("a copy is fresh for half the period", () => {
  const at = 1_000_000;
  expect(ModelsDev.fresh(undefined, at)).toBe(false);
  expect(ModelsDev.fresh({ at, body: {} }, at + 149e3)).toBe(true);
  expect(ModelsDev.fresh({ at, body: {} }, at + 151e3)).toBe(false);
});
