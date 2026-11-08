import { readFile, writeFile } from "node:fs/promises";
import { evidenceCoverageMatrix } from "../src/source-readiness/coverage.ts";

const target = new URL("../docs/evidence-coverage-v1.json", import.meta.url);
const { metrics, ...metadata } = evidenceCoverageMatrix();
// Keep one reviewable line per metric while retaining full per-source evidence.
const document = JSON.stringify(metadata, null, 2).slice(0, -2) + ',\n  "metrics": [\n'
  + metrics.map((metric) => "    " + JSON.stringify(metric)).join(",\n") + "\n  ]\n}\n";
const [operation] = process.argv.slice(2);
if (operation === "--write") await writeFile(target, document);
else if (operation === "--check") {
  if (await readFile(target, "utf8") !== document) throw new Error("Regenerate the evidence matrix with npm run source:matrix -- --write");
} else if (operation === undefined) process.stdout.write(document);
else throw new Error("Expected --write or --check");
