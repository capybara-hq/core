import { createLogger } from "@capybara-hq/kernel";
import { parseCli, USAGE, UsageError } from "./args.js";
import { runAdminCreate } from "./commands/admin-create.js";
import { runAdminGrant } from "./commands/admin-grant.js";
import { runMigrate } from "./commands/migrate.js";
import {
  runPluginsApprove,
  runPluginsInstall,
  runPluginsList,
  runPluginsReview,
  runPluginsState,
} from "./commands/plugins.js";
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
    case "admin-create":
      return runAdminCreate(
        {
          login: cmd.login,
          displayName: cmd.displayName,
          ...(cmd.email !== undefined && { email: cmd.email }),
        },
        log,
        process.env,
      );
    case "admin-grant":
      return runAdminGrant({ login: cmd.login, grant: cmd.grant }, log, process.env);
    case "plugins-review":
      return runPluginsReview(log, process.env);
    case "plugins-approve":
      return runPluginsApprove({ name: cmd.name, yes: cmd.yes }, log, process.env);
    case "plugins-list":
      return runPluginsList(log, process.env);
    case "plugins-install":
      return runPluginsInstall({ target: cmd.target, yes: cmd.yes }, log, process.env);
    case "plugins-state":
      return runPluginsState({ name: cmd.name, action: cmd.action }, log, process.env);
    case "start":
      return runStart(cmd.roles ? { roles: cmd.roles } : {}, log, process.env);
  }
}

const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
