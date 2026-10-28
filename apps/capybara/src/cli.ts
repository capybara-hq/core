import { createLogger, LOG_FORMATS, type LogFormat } from "@capybara-hq/kernel";
import { parseCli, USAGE, UsageError } from "./args.js";
import { runAdminCreate } from "./commands/admin-create.js";
import { runAdminGrant } from "./commands/admin-grant.js";
import { runBootstrap } from "./commands/bootstrap.js";
import {
  runExtensionsApprove,
  runExtensionsInstall,
  runExtensionsList,
  runExtensionsReview,
  runExtensionsState,
} from "./commands/extensions.js";
import { runMigrate } from "./commands/migrate.js";
import { runPluginsImport, runPluginsList } from "./commands/plugins.js";
import { runStart } from "./commands/start.js";
import { loadEnvFile, takeEnvFileOption } from "./env-file.js";
import { runShutdownHooks } from "./shutdown.js";

// The logger before any config is read; `capybara start` switches to the configured one. It
// honors CAPYBARA_LOG__FORMAT already (the dev:kernel script sets pretty under tee).
const envFormat = process.env.CAPYBARA_LOG__FORMAT;
const log = createLogger("info", {
  ...((LOG_FORMATS as readonly string[]).includes(envFormat ?? "") && {
    format: envFormat as LogFormat,
  }),
});

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
  let envFile: string | undefined;
  try {
    const { argv: rest, file } = takeEnvFileOption(argv);
    envFile = loadEnvFile(file, process.cwd());
    cmd = parseCli(rest);
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
    case "bootstrap":
      return runBootstrap(
        {
          ...(cmd.dir !== undefined && { dir: cmd.dir }),
          ...(cmd.manifest !== undefined && { manifest: cmd.manifest }),
        },
        log,
        process.env,
      );
    case "admin-create":
      return runAdminCreate(
        {
          login: cmd.login,
          displayName: cmd.displayName,
          ...(cmd.email !== undefined && { email: cmd.email }),
          ifNone: cmd.ifNone,
          ...(cmd.passwordFile !== undefined && { passwordFile: cmd.passwordFile }),
        },
        log,
        process.env,
      );
    case "admin-grant":
      return runAdminGrant({ login: cmd.login, grant: cmd.grant }, log, process.env);
    case "extensions-review":
      return runExtensionsReview(log, process.env);
    case "extensions-approve":
      return runExtensionsApprove({ name: cmd.name, yes: cmd.yes }, log, process.env);
    case "extensions-list":
      return runExtensionsList(log, process.env);
    case "extensions-install":
      return runExtensionsInstall({ target: cmd.target, yes: cmd.yes }, log, process.env);
    case "extensions-state":
      return runExtensionsState({ name: cmd.name, action: cmd.action }, log, process.env);
    case "plugins-list":
      return runPluginsList(log, process.env);
    case "plugins-import":
      return runPluginsImport(
        { target: cmd.target, yes: cmd.yes, deployExtension: cmd.deployExtension },
        log,
        process.env,
      );
    case "start":
      if (envFile !== undefined) log.info("loaded env file", { path: envFile });
      return runStart({ ...(cmd.roles !== undefined && { roles: cmd.roles }) }, log, process.env);
  }
}

const code = await main(process.argv.slice(2));
if (code !== undefined) {
  await runShutdownHooks();
  process.exit(code);
}
