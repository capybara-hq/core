import "reflect-metadata";
import type { BootstrapManifest } from "@capybara-hq/plugin-sdk";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ConfigSource } from "./config/load.js";
import type { KernelConfig } from "./config/schema.js";
import type { ConfigSourceKind } from "./config/sources.js";
import { createKernelAdapter } from "./http/adapter.js";
import { createHttpApp } from "./http/app.js";
import { NestLogAdapter } from "./http/nest-logger.js";
import { setupSwagger } from "./infra/swagger/swagger.js";
import { KernelModule } from "./kernel.module.js";
import { KernelLifecycle } from "./lifecycle/kernel-lifecycle.js";
import type { KernelLogger } from "./log.js";
import { createConfiguredLogger } from "./log-config.js";

/** What {@link createKernelApp} takes besides the config. */
export interface KernelAppOptions {
  /** 配置来源；提供 `watch` 时启用热更新。 */
  source?: ConfigSource;
  /** 解析插件裸包名的目录，默认 `process.cwd()`；相对路径按当前 cwd 解析。 */
  resolveFrom?: string;
  /** Defaults to a logger built from `config.log` and `config.roles` (createConfiguredLogger). */
  logger?: KernelLogger;
  /** 热更新时与来源原始值合并的环境变量，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /**
   * The bootstrap step (package ecosystem spec §7, startup bootstrap spec). When given, the start
   * runs it (see `extensions/bootstrap.ts`) before loading extensions unless it is already done for
   * the manifest, and refuses to start when it cannot complete a required entry. `dir`: the
   * optional offline directory whose `*.tgz` files are matched to the entries by sha512 (a missing
   * directory is an empty one); entries without a matching file are downloaded from
   * `packages.npmRegistry`. Omitted: no bootstrap step (tests, unless they ask for it).
   */
  bootstrap?: { dir?: string };
  /** The bootstrap manifest; default the `bootstrap.json` shipped with the kernel package. */
  bootstrapManifest?: BootstrapManifest;
  /**
   * Where each extension deployment config field of the startup config comes from (the
   * `extensionConfigSources` returned by `loadConfigWithSources`); these fields are read-only in the
   * admin console (D8). When omitted it is derived from `config.extensionConfig`: fields present in
   * the environment are `env`, the rest take the `CAPYBARA_CONFIG_SOURCE` kind (file / nacos).
   */
  extensionConfigSources?: Record<string, Record<string, ConfigSourceKind>>;
  /**
   * Providers that replace the application's own (tests). They are registered in the legacy graph's
   * module, so they replace what the legacy graph and the modules built on it resolve.
   */
  overrides?: { provide: unknown; useValue: unknown }[];
}

/**
 * Builds the kernel application (one Nest application, root module {@link KernelModule}) and sets
 * up its HTTP side, without initializing it: nothing connects and nothing starts. A failure
 * releases what was created (Redis connections, the pool) before it is thrown. Internal: the
 * temporary `createKernel` facade starts it later; everything else uses {@link createKernelApp}.
 */
export async function buildKernelApp(
  config: KernelConfig,
  options: KernelAppOptions = {},
): Promise<NestFastifyApplication> {
  const logger = options.logger ?? createConfiguredLogger(config);
  const app = await NestFactory.create<NestFastifyApplication>(
    KernelModule.forRoot(config, { ...options, logger }),
    createKernelAdapter(config.http.trustProxy),
    { logger: new NestLogAdapter(logger), abortOnError: false },
  );
  const lifecycle = app.get(KernelLifecycle);
  const gateway = lifecycle.gatewayRoutes();
  try {
    lifecycle.attachHttp(
      await createHttpApp(
        {
          log: logger,
          // The health endpoints and the API are KernelModule's; only the Fastify side is set up here
          health: { isStopping: () => lifecycle.isStopping(), log: logger, checks: {} },
          serveApi: config.roles.includes("api"),
          servePlugins: config.roles.includes("api") || config.roles.includes("gateway"),
          ...(gateway !== undefined && { gateway }),
          trustProxy: config.http.trustProxy,
          replicaId:
            config.http.replicaId === undefined ? undefined : String(config.http.replicaId),
          packageMaxBytes: config.packages.maxBytes,
        },
        app,
      ),
    );
    setupSwagger(app, config.http.swagger);
  } catch (e) {
    // Nothing started: only release the connections (the stop phases are skipped)
    lifecycle.releaseOnly();
    await app.close();
    throw e;
  }
  return app;
}

/**
 * Initializes a built kernel application: `init()` runs the start sequence
 * (`KernelLifecycle.onApplicationBootstrap`). A failure (unless a stop was requested meanwhile) is
 * logged; either way the application is closed (the stop phases, then Redis and the pool) before
 * the error is thrown.
 */
async function initKernelApp(app: NestFastifyApplication): Promise<void> {
  const lifecycle = app.get(KernelLifecycle);
  try {
    await app.init();
  } catch (e) {
    if (!lifecycle.isStopping()) lifecycle.log.error("kernel start failed", { err: e });
    await app.close();
    throw e;
  }
}

/**
 * Creates the kernel application and runs its start sequence (nest kernel spec §4): Redis,
 * migrations, the official marketplace, the bootstrap step, the extension load, the role parts,
 * extension routes, the lifecycle reconcile and the config watch. Does not listen.
 */
export async function createKernelApp(
  config: KernelConfig,
  options: KernelAppOptions = {},
): Promise<NestFastifyApplication> {
  const app = await buildKernelApp(config, options);
  await initKernelApp(app);
  return app;
}

/**
 * {@link createKernelApp}, then shutdown hooks on SIGTERM / SIGINT and `listen(config.http.port)`:
 * nothing is served before the start sequence finished.
 */
export async function startKernelApp(
  config: KernelConfig,
  options: KernelAppOptions = {},
): Promise<NestFastifyApplication> {
  const app = await createKernelApp(config, options);
  app.enableShutdownHooks();
  const lifecycle = app.get(KernelLifecycle);
  try {
    await lifecycle.listen(config.http.port);
  } catch (e) {
    if (!lifecycle.isStopping()) lifecycle.log.error("kernel start failed", { err: e });
    await app.close();
    throw e;
  }
  return app;
}
