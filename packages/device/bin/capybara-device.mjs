#!/usr/bin/env node
// The `capybara-device` bin: runs the compiled CLI (dist/cli.js, built by `tsc -b`).
import { existsSync } from "node:fs";

const dist = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(dist)) {
  process.stderr.write("capybara-device: dist/cli.js not found; build the package first\n");
  process.exit(1);
}
const { runCli } = await import(dist.href);
process.exitCode = await runCli(process.argv.slice(2));
