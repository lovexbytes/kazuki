// Browse
// ======
// A link opened in the browser here, if any: a Linux with no desktop has
// no xdg-open (spawning one missing throws). The terminal's chat
// (/tree) opens links by it.

import * as child from "node:child_process"

export function browse(url: string): void {
  const open = Bun.which(process.platform === "darwin" ? "open" : "xdg-open")
  if (open !== null) {
    child.spawn(open, [url], {detached: true, stdio: "ignore"}).unref()
  }
}
