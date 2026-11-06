import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import {
  createLogger,
  installProcessGuards,
  type KernelLogger,
  LOG_FORMATS,
  type LogFormat,
} from "@capybara-hq/kernel";
import { type Command, parseCli, USAGE, UsageError } from "./args.js";
import { type PasswordInput, runAdminCreate } from "./commands/admin-create.js";
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
import { exitAfterShutdown, runShutdownHooks } from "./shutdown.js";

/** The streams and environment a CLI run reads and writes (the process's own in the real CLI). */
export interface CliIo {
  stdin: PasswordInput;
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
  /** The environment the command reads; the env file is loaded into it. */
  env: NodeJS.ProcessEnv;
  /** The directory a relative `--env-file` (and the default `.env`) is resolved against. */
  cwd: string;
}

/** Options of {@link main}. */
export interface MainOptions {
  /** The logger before any config is read; default {@link cliLogger} on `io`. */
  logger?: KernelLogger;
  /**
   * Called once the command is known, before it runs. The process entry installs the process-wide
   * handlers here; the returned function receives the configured logger of `capybara start`.
   */
  onCommand?: (command: Command["command"], log: KernelLogger) => (log: KernelLogger) => void;
}

/**
 * The logger before any config is read; `capybara start` switches to the configured one. It honors
 * CAPYBARA_LOG__FORMAT already (the dev:kernel script sets pretty under tee) and writes to
 * `io.stdout`.
 */
export function cliLogger(io: Pick<CliIo, "stdout" | "env">): KernelLogger {
  const envFormat = io.env.CAPYBARA_LOG__FORMAT;
  return createLogger("info", {
    ...((LOG_FORMATS as readonly string[]).includes(envFormat ?? "") && {
      format: envFormat as LogFormat,
    }),
    out: io.stdout,
    isTTY: io.stdout.isTTY === true,
  });
}

/**
 * Loads an env file into `env`: Node's own loader for the process environment, else the same parser
 * into the given object (variables already set win over the file either way).
 */
function envFileLoader(env: NodeJS.ProcessEnv): (path: string) => void {
  if (env === process.env) return process.loadEnvFile;
  return (path) => {
    for (const [k, v] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
      if (env[k] === undefined) env[k] = v;
    }
  };
}

/**
 * Runs the CLI on `argv` (without the node and script arguments): loads the env file into
 * `io.env`, parses the command and runs it with `io`. Returns the exit code (2 for a usage error),
 * or undefined when `capybara start` keeps the kernel running (its signal handling owns the exit).
 * Everything the command writes, logger records included, goes to `io`; nothing here touches the
 * process except through `opts.onCommand` and `capybara start` (signals, exit after a stop).
 */
export async function main(
  argv: string[],
  io: CliIo,
  opts: MainOptions = {},
): Promise<number | undefined> {
  const log = opts.logger ?? cliLogger(io);
  const { env } = io;
  let cmd: Command;
  let envFile: string | undefined;
  try {
    const { argv: rest, file } = takeEnvFileOption(argv);
    envFile = loadEnvFile(file, io.cwd, envFileLoader(env));
    cmd = parseCli(rest);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.stderr.write(`capybara: ${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  const useLogger = opts.onCommand?.(cmd.command, log) ?? (() => {});
  switch (cmd.command) {
    case "help":
      io.stdout.write(`${USAGE}\n`);
      return 0;
    case "migrate":
      return runMigrate(log, env);
    case "bootstrap":
      return runBootstrap(
        {
          ...(cmd.dir !== undefined && { dir: cmd.dir }),
          ...(cmd.manifest !== undefined && { manifest: cmd.manifest }),
        },
        log,
        env,
        io,
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
        env,
        io,
      );
    case "admin-grant":
      return runAdminGrant({ login: cmd.login, grant: cmd.grant }, log, env, io);
    case "extensions-review":
      return runExtensionsReview(log, env, io);
    case "extensions-approve":
      return runExtensionsApprove({ name: cmd.name, yes: cmd.yes }, log, env, io);
    case "extensions-list":
      return runExtensionsList(log, env, io);
    case "extensions-install":
      return runExtensionsInstall({ target: cmd.target, yes: cmd.yes }, log, env, io);
    case "extensions-state":
      return runExtensionsState({ name: cmd.name, action: cmd.action }, log, env, io);
    case "plugins-list":
      return runPluginsList(log, env, io);
    case "plugins-import":
      return runPluginsImport(
        { target: cmd.target, yes: cmd.yes, deployExtension: cmd.deployExtension },
        log,
        env,
        io,
      );
    case "start":
      if (envFile !== undefined) log.info("loaded env file", { path: envFile });
      return runStart(
        { ...(cmd.roles !== undefined && { roles: cmd.roles }) },
        log,
        env,
        exitAfterShutdown,
        process,
        useLogger,
      );
  }
}

/**
 * The process-wide handlers: `capybara start` (a long-running kernel) gets the process guards (an
 * unhandled rejection or uncaught exception is logged through the kernel logger; more than 5 within
 * 60 s exit with 1); every other command is short-lived and exits with 1 on the first one.
 */
function installFatalHandlers(command: string, log: KernelLogger): (log: KernelLogger) => void {
  if (command === "start") {
    let current: KernelLogger = log;
    installProcessGuards({
      log: () => current,
      exit: (code) => {
        void current
          .flush()
          .catch(() => {})
          .then(() => exitAfterShutdown(code));
      },
    });
    return (l) => {
      current = l;
    };
  }
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection; exiting", { err: reason });
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception; exiting", { err });
    process.exit(1);
  });
  return () => {};
}

/**
 * The process entry (main.ts runs it): {@link main} on the process's arguments, streams and
 * environment with the process-wide handlers, then the shutdown hooks and the exit with its code.
 */
export async function runProcess(): Promise<void> {
  const code = await main(
    process.argv.slice(2),
    {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      cwd: process.cwd(),
    },
    { onCommand: installFatalHandlers },
  );
  if (code !== undefined) {
    await runShutdownHooks();
    process.exit(code);
  }
}
