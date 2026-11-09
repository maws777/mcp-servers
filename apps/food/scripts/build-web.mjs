// Builds the dashboard site into web/dist:
//   index.html                 references the hashed files below
//   assets/app-<hash>.js|css   content-hashed: cacheable for a year, a new
//                              build gets new names, so no stale code
//   manifest.webmanifest, icons (from web/public)
// config.json is not built here: Terraform writes it (Cognito client ID,
// domain), so the same build runs in staging and prod.

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const out = "web/dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: { app: "web/src/main.ts", style: "web/src/style.css" },
  bundle: true,
  format: "esm",
  target: ["safari16"], // iOS 16.4+ for the home-screen app (web push in 4c)
  minify: true,
  outdir: `${out}/assets`,
  entryNames: "[name]-[hash]",
  metafile: true,
  logLevel: "info",
});

const outputs = Object.keys(result.metafile.outputs).map((p) => basename(p));
const js = outputs.find((f) => f.startsWith("app-") && f.endsWith(".js"));
const css = outputs.find((f) => f.startsWith("style-") && f.endsWith(".css"));
if (!js || !css) throw new Error(`missing outputs: ${outputs.join(", ")}`);

const html = readFileSync("web/index.html", "utf8").replace("__JS__", `/assets/${js}`).replace("__CSS__", `/assets/${css}`);
writeFileSync(`${out}/index.html`, html);
cpSync("web/public", out, { recursive: true });
console.log(`site: ${out} (${js}, ${css})`);
