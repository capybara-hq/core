/**
 * `capybara-plugin`: pack, check, sync the versions of and release Capybara plugins.
 *
 *   capybara-plugin pack [<dir>...] [--all <root>] [--out <dir>]
 *   capybara-plugin pack --bootstrap <manifest> [--root <dir>] [--out <dir>] [--registry <url>]
 *                        [--npm-token <token>]
 *   capybara-plugin check [--root <dir>] [--plugins <glob>] [--base <ref>]
 *   capybara-plugin sync-versions [--root <dir>] [--plugins <glob>]
 *   capybara-plugin marketplace --write|--check [--root <dir>] [--file <path>] [--plugins <glob>]
 *   capybara-plugin release [--dry-run] [--provenance] [--out <dir>] [--auto] [--root <dir>]
 *                           [--plugins <glob>] [--marketplace <file>]
 *
 * Relative paths resolve against the current directory of the process (`capybara-plugin pack .`
 * in a package script packs that package). `<command> --help` prints one command's usage.
 */
import { CHECK_USAGE, checkCommand } from "./check/cli.js";
import { SYNC_VERSIONS_USAGE, syncVersionsCommand } from "./check/sync-versions-cli.js";
import { MARKETPLACE_USAGE, marketplaceCommand } from "./marketplace/cli.js";
import { PACK_USAGE, packCommand } from "./pack/cli.js";
import { RELEASE_USAGE, releaseCommand } from "./release/cli.js";

const COMMANDS: Record<string, (args: string[], cwd: string) => Promise<number>> = {
  pack: packCommand,
  check: checkCommand,
  "sync-versions": syncVersionsCommand,
  marketplace: marketplaceCommand,
  release: releaseCommand,
};

const USAGE = `usage: ${[PACK_USAGE, CHECK_USAGE, SYNC_VERSIONS_USAGE, MARKETPLACE_USAGE, RELEASE_USAGE].join("\n       ")}`;

const [command, ...args] = process.argv.slice(2);
const run = command === undefined ? undefined : COMMANDS[command];
if (command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
} else if (run === undefined) {
  console.error(`${command === undefined ? "no command" : `unknown command ${command}`}\n${USAGE}`);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await run(args, process.cwd());
  } catch (e) {
    // parseArgs rejects unknown options and missing values.
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    process.exitCode = 2;
  }
}
