#!/usr/bin/env node
// The `capybara-device` bin: runs the compiled CLI (dist/cli.js, built by `tsc -b`).
import { existsSync } from "node:fs";

const dist = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(dist)) {
  process.stderr.write("capybara-device: dist/cli.js not found; build the package first\n");
  process.exit(1);
}
const { runCli } = await import(dist.href);
if (process.argv[2] === "start") {
  // The service log has no clock: date a crash like every other line, then exit 1 as Node does.
  const { installCrashLog } = await import(
    new URL("../dist/log-timestamp.js", import.meta.url).href
  );
  installCrashLog();
}
process.exitCode = await runCli(process.argv.slice(2));
