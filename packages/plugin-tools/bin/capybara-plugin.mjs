#!/usr/bin/env node
// The `capybara-plugin` bin: runs the compiled CLI (dist/cli.js, built by `tsc -b`). In this
// repository, the root scripts (pnpm pack-plugin, pack-plugins, pack-bootstrap, release) run the
// TypeScript sources through tsx instead.
import { existsSync } from "node:fs";

const dist = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(dist)) {
  process.stderr.write("capybara-plugin: dist/cli.js not found; build the package first\n");
  process.exit(1);
}
await import(dist.href);
