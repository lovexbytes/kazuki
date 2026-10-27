// Unowned
// =======
// A rejection no one handles (Main.unowned) leaves the worker alive.
// Run by crash.test.ts in its own process; prints "alive" if it lives.

import {Main} from "../../src/core/server/main.ts"

process.on("unhandledRejection", Main.unowned)
Promise.reject(new Error("nobody's"))
setTimeout(() => {
  console.log("alive")
  process.exit(0)
}, 100)
