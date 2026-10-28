#!/usr/bin/env node
// CLI entry. In a repo checkout (src/main.ts present) it runs the TypeScript sources through tsx, so
// a stale dist never shadows edits. In a production install (pnpm deploy / the kernel image) only
// `bin` and `dist` ship, and it runs the `tsc -b` output with plain Node: tsx is a devDependency and
// is imported lazily, so the dist path never loads it.
import { existsSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const source = new URL("../src/main.ts", import.meta.url);
const dist = new URL("../dist/main.js", import.meta.url);

/** tsx's ESM API, or undefined when tsx is not installed (sources present without devDependencies). */
async function loadTsx() {
  try {
    return await import("tsx/esm/api");
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}

const tsx = existsSync(source) ? await loadTsx() : undefined;
if (tsx) {
  // tsx only honors the tsconfig in the working directory (when its include covers the file), so
  // running from elsewhere would drop experimentalDecorators for the kernel sources (Nest decorators
  // fail to compile); point it at the repo's tsconfig.base.json explicitly. Also add the
  // `@capybara-hq/source` export condition so workspace packages resolve to src instead of dist.
  tsx.register({
    tsconfig: fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url)),
  });
  register(
    "data:text/javascript,export function resolve(s, c, next) { return next(s, { ...c, conditions: [...c.conditions, '@capybara-hq/source'] }); }",
  );
  await import(source.href);
} else {
  if (existsSync(source)) {
    process.stderr.write(
      "capybara: tsx is not installed (dev dependencies missing); running the compiled dist instead," +
        " which may be stale; run `pnpm install` to use the sources\n",
    );
  }
  if (!existsSync(dist)) {
    process.stderr.write(
      "capybara: dist/main.js not found; run `pnpm -r --filter '@capybara-hq/capybara...' build` first\n",
    );
    process.exit(1);
  }
  await import(dist.href);
}
