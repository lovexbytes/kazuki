// build
// =====
// The kazuki executable: src/cli.ts and all it carries (the server, the
// terminal's chat), compiled for a platform. The chat's JSX (src/tui/) is
// Solid's, so it builds with OpenTUI's transform, as `bun src/cli.ts` runs
// it (bunfig.toml's preload).
//
// Usage: bun scripts/build.ts [--target=bun-darwin-arm64] [--outfile kazuki]
// (no target: this computer's)

import solid from "@opentui/solid/bun-plugin";

const args    = process.argv.slice(2);
const flag    = (name: string) => {
  const at = args.findIndex((a) => a === "--" + name || a.startsWith("--" + name + "="));
  return at < 0 ? undefined : args[at].includes("=") ? args[at].split("=")[1] : args[at + 1];
};
const target  = flag("target");
const outfile = flag("outfile") ?? "kazuki";

const out = await Bun.build({
  entrypoints : [import.meta.dir + "/../src/cli.ts"],
  plugins     : [solid],
  minify      : true,
  compile     : {
    ...(target === undefined ? {} : { target: target as Bun.Build.CompileTarget }),
    outfile,
    autoloadBunfig : false,
    autoloadDotenv : false,
  },
});

if (!out.success) {
  for (const log of out.logs) {
    console.error(log);
  }
  process.exit(1);
}
