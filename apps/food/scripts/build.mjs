// Bundles the two Lambdas, each into one file + source map:
//   dist/mcp/index.mjs        the MCP server (src/lambda.ts)
//   dist/dashboard/index.mjs  the dashboard API (src/dashboard/lambda.ts)
// Each folder becomes its own zip (infra/main.tf), so each function ships
// only its own code.
//
// ES module output so the entries can use top-level await (runs during the
// Lambda init phase). Some dependencies are CommonJS and call require();
// an ES module has no require, so the banner recreates it.

import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: { "mcp/index": "src/lambda.ts", "dashboard/index": "src/dashboard/lambda.ts" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: true,
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
