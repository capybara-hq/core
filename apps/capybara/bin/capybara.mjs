#!/usr/bin/env node
// CLI entry. In a repo checkout (src/cli.ts present) it runs the TypeScript sources through tsx, so
// a stale dist never shadows edits. In a production install (pnpm deploy / the kernel image) only
// `bin` and `dist` ship, and it runs the `tsc -b` output with plain Node: tsx is a devDependency and
// is imported lazily, so the dist path never loads it.
import { existsSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const source = new URL("../src/cli.ts", import.meta.url);

if (existsSync(source)) {
  // tsx only honors the tsconfig in the working directory (when its include covers the file), so
  // running from elsewhere would drop experimentalDecorators for the kernel sources (Nest decorators
  // fail to compile); point it at the repo's tsconfig.base.json explicitly. Also add the
  // `@capybara-hq/source` export condition so workspace packages resolve to src instead of dist.
  const { register: registerTsx } = await import("tsx/esm/api");
  registerTsx({ tsconfig: fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url)) });
  register(
    "data:text/javascript,export function resolve(s, c, next) { return next(s, { ...c, conditions: [...c.conditions, '@capybara-hq/source'] }); }",
  );
  await import(source.href);
} else {
  await import(new URL("../dist/cli.js", import.meta.url).href);
}
