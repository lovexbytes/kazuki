// Bundle test
// ===========
// `bun test bundle.test.ts`. The web bundle must not carry server code,
// which reads process.env and the disk as it loads.

import { expect, test } from "bun:test";

test("the web bundle carries no server code", async () => {
  const out  = await Bun.build({ entrypoints: [import.meta.dir + "/../web/src/main.ts"], target: "browser" });
  const text = await out.outputs[0].text();
  expect(out.success).toBe(true);
  expect(text).not.toContain("KAZUKI_DIR");
});
