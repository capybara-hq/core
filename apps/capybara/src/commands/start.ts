import {
  configSourceKind,
  createConfiguredLogger,
  createKernel,
  extensionConfigSources,
  handleShutdownSignals,
  type KernelLogger,
  resolveConfig,
  selectConfigSource,
} from "@capybara-hq/kernel";
import type { Role } from "../args.js";
import { exitAfterShutdown } from "../shutdown.js";
import { bootstrapDirOf } from "./bootstrap.js";

/**
 * `capybara start`: loads the config → creates the kernel → installs the SIGTERM / SIGINT handlers
 * (`handleShutdownSignals`: the first signal stops gracefully, then exits; a second one exits with 1
 * at once) → starts the kernel. A signal during the start aborts it at its next checkpoint.
 * `--role` is injected as an environment override of `CAPYBARA_ROLES`, so it also holds when a
 * config hot reload merges the config again. `onLogger` receives the configured logger once it
 * exists (the process guards of the CLI log through it from then on).
 * The kernel always runs the bootstrap step before loading extensions unless it is done, from the
 * offline directory of config `bootstrap.dir` (see {@link bootstrapDirOf}) or else npm; a required
 * bootstrap plugin it cannot install keeps it from listening.
 * Returns undefined when the kernel runs (or a signal during the start owns the exit); a number is
 * the exit code to use at once.
 */
export async function runStart(
  opts: { roles?: Role[] },
  cliLog: KernelLogger,
  baseEnv: NodeJS.ProcessEnv,
  exit: (code: number) => void = exitAfterShutdown,
  signals: Pick<NodeJS.EventEmitter, "on" | "off"> = process,
  onLogger: (log: KernelLogger) => void = () => {},
): Promise<number | undefined> {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (opts.roles) env.CAPYBARA_ROLES = JSON.stringify(opts.roles);
  let kernel: Awaited<ReturnType<typeof createKernel>>;
  // The CLI logger until the config is read; then the one `log.*` and `roles` configure.
  let log = cliLog;
  try {
    const source = selectConfigSource(env);
    const raw = await source.load();
    const config = resolveConfig(raw, env);
    log = createConfiguredLogger(config);
    onLogger(log);
    kernel = await createKernel(config, {
      source,
      logger: log,
      env,
      bootstrap: { dir: bootstrapDirOf(config) },
      // 启动配置里有的插件部署配置字段在后台只读并显示来源（D8）
      extensionConfigSources: extensionConfigSources(raw, env, configSourceKind(env)),
    });
  } catch (e) {
    log.error("cannot load configuration", { err: e });
    return 1;
  }

  const handle = handleShutdownSignals(() => kernel.stop(), log, { signals, exit });

  try {
    await kernel.start();
  } catch {
    // A signal during the start: the start was aborted, not failed; the signal path exits with 0
    const exiting = handle.exiting();
    if (exiting) {
      await exiting;
      return undefined;
    }
    // A failed start: the kernel logged why and released its resources
    handle.dispose();
    return 1;
  }
  return undefined;
}
