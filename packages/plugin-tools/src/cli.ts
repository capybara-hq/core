/**
 * `capybara-plugin`: pack, check and release Capybara plugins.
 *
 *   capybara-plugin pack [<dir>...] [--all <root>] [--out <dir>]
 *   capybara-plugin pack --bootstrap <manifest> [--root <dir>] [--out <dir>]
 *   capybara-plugin check [--root <dir>] [--plugins <glob>] [--base <ref>]
 *   capybara-plugin release [--dry-run] [--provenance] [--out <dir>] [--auto] [--root <dir>]
 *
 * Relative paths on the command line resolve against the directory it was invoked from (`INIT_CWD`
 * under a package manager script, else the current directory); the default root and output
 * directories are under the current directory of the process.
 */
import { CHECK_USAGE, checkCommand } from "./check/cli.js";
import { type CommandDirs, processDirs } from "./cli-dirs.js";
import { PACK_USAGE, packCommand } from "./pack/cli.js";
import { RELEASE_USAGE, releaseCommand } from "./release/cli.js";

const COMMANDS: Record<string, (args: string[], dirs: CommandDirs) => Promise<number>> = {
  pack: packCommand,
  check: checkCommand,
  release: releaseCommand,
};

const USAGE = `usage: ${PACK_USAGE}\n       ${CHECK_USAGE}\n       ${RELEASE_USAGE}`;

const [command, ...args] = process.argv.slice(2);
const run = command === undefined ? undefined : COMMANDS[command];
if (command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
} else if (run === undefined) {
  console.error(`${command === undefined ? "no command" : `unknown command ${command}`}\n${USAGE}`);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await run(args, processDirs());
  } catch (e) {
    // parseArgs rejects unknown options and missing values.
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    process.exitCode = 2;
  }
}
