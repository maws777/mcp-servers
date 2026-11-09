// Bundles the Lambda into dist/index.mjs (one file + source map).
//
// ES module output so the entry can use top-level await (runs during the
// Lambda init phase). Some dependencies are CommonJS and call require();
// an ES module has no require, so the banner recreates it.

import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/lambda.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: true,
  outfile: "dist/index.mjs",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
