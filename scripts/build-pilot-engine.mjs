import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const outfile = fileURLToPath(new URL("../dist/pilot-engine.mjs", import.meta.url));
const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/pilot/engine-entry.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  metafile: true,
  write: false,
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
});
const outputs = Object.values(result.metafile.outputs);
if (outputs.length !== 1 || outputs[0].imports.some(({ external, path, kind }) =>
  !external || path !== "node:crypto" || kind !== "import-statement")) {
  throw new Error("Pilot bundle may import only the approved Node crypto builtin");
}
await mkdir(dirname(outfile), { recursive: true });
await writeFile(outfile, result.outputFiles[0].contents);
