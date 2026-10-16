#!/usr/bin/env -S tsx --conditions=source
import { createLogger } from "@capybara-hq/kernel";
import { parseCli, USAGE, UsageError } from "./args.js";
import { runMigrate } from "./commands/migrate.js";
import { runStart } from "./commands/start.js";

const log = createLogger("info");

process.on("unhandledRejection", (reason) => {
  log.error("unhandled promise rejection; exiting", { err: reason });
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  log.error("uncaught exception; exiting", { err });
  process.exit(1);
});

async function main(argv: string[]): Promise<number | undefined> {
  let cmd: ReturnType<typeof parseCli>;
  try {
    cmd = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`capybara: ${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  switch (cmd.command) {
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "migrate":
      return runMigrate(log, process.env);
    case "start":
      return runStart(cmd.roles ? { roles: cmd.roles } : {}, log, process.env);
  }
}

const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
