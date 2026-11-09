// Fails if the dashboard's code could turn a string into HTML.
//
// Meal descriptions come from what I typed or photographed, through Claude:
// untrusted. The page only builds DOM with web/src/dom.ts (text nodes), and
// this check keeps it that way: any of these in web/src fails CI.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write/, /\beval\s*\(/, /\bnew Function\b/, /\bcreateContextualFragment\b/, /\bDOMParser\b/];

const files = readdirSync("web/src", { recursive: true })
  .map(String)
  .filter((f) => /\.(ts|js)$/.test(f));

let failures = 0;
for (const file of files) {
  const lines = readFileSync(join("web/src", file), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const re of FORBIDDEN) {
      if (re.test(line)) {
        console.error(`web/src/${file}:${i + 1}: ${re} is not allowed (render text with dom.ts)`);
        failures++;
      }
    }
  });
}

if (failures) process.exit(1);
console.log(`check-web: ${files.length} files, no HTML sinks`);
