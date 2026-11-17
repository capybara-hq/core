/**
 * Package-build generator of the canonical installed-byte manifest (permission runtime cutover
 * B4). Run after `tsc -b`: it loads the EMITTED verifier module and enumerates the emitted
 * JavaScript, the inline helper sources and the installed sandbox runtime closure exactly as the
 * device will verify them, then writes `dist/runtime-manifest.json`. It fails when a helper module
 * has a dynamic import it cannot enumerate or imports an uncovered package. TypeScript sources
 * are never hashed in place of the shipped JavaScript.
 *
 *   node packages/device/tools/runtime-manifest.ts [packageRoot]
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function generateRuntimeManifest(packageRoot: string): Promise<string> {
  const emitted = (await import(
    pathToFileURL(join(packageRoot, "dist", "exec", "runtime-manifest.js")).href
  )) as typeof import("../src/exec/runtime-manifest.js");
  const layout = { ...emitted.installedLayout(), packageRoot };
  const { runtime, helpers } = await emitted.enumerateInstalled(layout);
  const out = join(packageRoot, "dist", emitted.MANIFEST_FILE);
  await writeFile(out, `${JSON.stringify({ version: 1, runtime, helpers })}\n`, { mode: 0o644 });
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  generateRuntimeManifest(root).then(
    (out) => console.log(`wrote ${out}`),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
