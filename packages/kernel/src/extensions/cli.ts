import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import type { Keyring } from "../ctx/secrets.js";
import { KernelCliModule } from "../infra/cli/kernel-cli.module.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_BUS, KEYRING } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ExtensionAdminOps } from "./admin-ops.js";
import { ExtensionAdmin, type PublishBus } from "./admin-view.js";
import { ExtensionApprovals } from "./approvals.js";
import { ExtensionBlobs } from "./blobs.js";
import { BootstrapService } from "./bootstrap.js";
import { type ConfigIssue, toIssues } from "./config-issues.js";
import {
  mergeDeploymentConfig,
  readStoredDeploymentConfig,
  schemaFields,
  secretPathsOf,
} from "./deployment-config-store.js";
import { ExtensionsModule } from "./extensions.module.js";
import { ExtensionHost, type InspectedExtension } from "./host.js";
import { ExtensionInstalls } from "./installs.js";
import { PLUGINS_CHANGED_TOPIC } from "./lifecycle-topics.js";
import {
  ExtensionPackageError,
  extensionPackageApiError,
  permissionSetOfPackage,
  readExtensionPackage,
} from "./package.js";
import type { PermissionSet } from "./permission-set.js";

/** {@link openExtensionCli} 的结果：CLI 的 `capybara extensions *` 共用。 */
export interface ExtensionCli {
  config: KernelConfig;
  /**
   * The command's Nest application context (ruling R13): the extension providers, the database
   * and the CLI's Redis. Closed by {@link close}.
   */
  app: INestApplicationContext;
  /** 配置声明的插件（导入、按依赖排序，不 setup）。 */
  inspected: InspectedExtension[];
  /**
   * 配置声明插件的部署配置问题（启动配置与 PG 里保存的合并后按 schema 校验；只有路径与说明，不含值）：
   * 有问题的插件内核不加载（待配置）。没有问题的不在这里。
   */
  configIssues: ReadonlyMap<string, ConfigIssue[]>;
  /** The valid merged deployment config (secrets decrypted) of the declared extensions that have one. */
  deploymentConfigs: ReadonlyMap<string, unknown>;
  /**
   * The deployment config of any extension (an install record too) validated against `schema`: the
   * startup config completed by the fields stored in PG, as the kernel merges it. No schema = `{}`.
   */
  deploymentConfigOf(
    name: string,
    schema: z.ZodTypeAny | undefined,
  ): Promise<{ ok: true; value: unknown } | { ok: false; issues: ConfigIssue[] }>;
  installs: ExtensionInstalls;
  admin: ExtensionAdmin;
  ops: ExtensionAdminOps;
  approvals: ExtensionApprovals;
  /** The bootstrap step (`capybara bootstrap`), under the same `lock:bootstrap` as the kernel (R14). */
  bootstrap: BootstrapService;
  /** CLI 本次刚导入的包字节（降级判断等读包时优先用它：包可能存在 CLI 读不到的对象存储里）。 */
  remember(sha256: string, bytes: Uint8Array): void;
  /** 安装记录包的权限集合（与后台审阅相同）；包在对象存储里时 CLI 读不到，抛错。 */
  packageSet(sha256: string): Promise<PermissionSet>;
  /** The bytes of a stored package (this process's imports first, then the package store in PG). */
  readPackage(sha256: string): Promise<Uint8Array>;
  /** 写完 PG 后经 Redis 发布 `kernel.plugins.changed`（C18）；失败只告警，返回是否发布成功。 */
  publishChanged(plugin: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * The CLI's extension management context (C18, F-Q; ruling R13): a Nest application context with
 * the extensions module over the database and a lazy Redis connection used only for publishing
 * and the bootstrap lock. It loads no extension and runs no extension's `setup` (a catalog import
 * sets up the declared object-store extension itself, see `openCatalogCli`). Packages the CLI
 * imports are always stored in PG (`blob_store = 'pg'`); replicas read by `blob_store`. Install /
 * enable / disable / uninstall share {@link ExtensionAdminOps} with the admin console (actor null,
 * audits without an actor); after writing PG it publishes `kernel.plugins.changed` and running
 * replicas reconcile; a failed publish only warns (the periodic reconcile catches up).
 */
export async function openExtensionCli(
  config: KernelConfig,
  log: KernelLogger,
  opts: { resolveFrom?: string } = {},
): Promise<ExtensionCli> {
  const inspected = await ExtensionHost.inspect(config.extensions, {
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
  });
  const app = await NestFactory.createApplicationContext(
    KernelCliModule.forRoot(config, {
      logger: log,
      ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
      modules: [ExtensionsModule],
    }),
    { logger: false, abortOnError: false },
  );
  const close = () => app.close().catch(() => {});
  const db = app.get(KernelDb);
  const keyring = app.get<Keyring>(KEYRING);
  const blobs = app.get(ExtensionBlobs);
  // 部署配置 = 启动配置补上后台保存在 PG 的字段（C10）；不合法的插件内核不加载（待配置）
  const deploymentConfigOf: ExtensionCli["deploymentConfigOf"] = async (name, schema) => {
    if (!schema) return { ok: true, value: {} };
    const stored = await readStoredDeploymentConfig(db.db, keyring, name, {
      secretPaths: secretPathsOf(schemaFields(schema)),
    });
    const r = schema.safeParse(
      mergeDeploymentConfig(
        stored,
        config.extensionConfig[name],
        schemaFields(schema).map((f) => f.path),
      ),
    );
    return r.success ? { ok: true, value: r.data } : { ok: false, issues: toIssues(r.error) };
  };
  const configIssues = new Map<string, ConfigIssue[]>();
  const deploymentConfigs = new Map<string, unknown>();
  try {
    for (const p of inspected) {
      const schema = p.manifest.config?.deployment;
      if (!schema) continue;
      const r = await deploymentConfigOf(p.manifest.name, schema);
      if (r.ok) deploymentConfigs.set(p.manifest.name, r.value);
      else configIssues.set(p.manifest.name, r.issues);
    }
  } catch (e) {
    await close();
    throw e;
  }
  // The admin view, the operations and the bootstrap step see the declared extensions as a
  // replica would (the CLI checked their deployment config above)
  app
    .get(ExtensionHost)
    .noteInspected(
      inspected,
      new Map(inspected.map((p) => [p.manifest.name, !configIssues.has(p.manifest.name)])),
    );
  const bus = app.get<PublishBus>(KERNEL_BUS);
  return {
    config,
    app,
    inspected,
    configIssues,
    deploymentConfigs,
    deploymentConfigOf,
    installs: app.get(ExtensionInstalls),
    admin: app.get(ExtensionAdmin),
    ops: app.get(ExtensionAdminOps),
    approvals: app.get(ExtensionApprovals),
    bootstrap: app.get(BootstrapService),
    remember: (sha256, bytes) => blobs.remember(sha256, bytes),
    readPackage: (sha256) => blobs.get(sha256),
    async packageSet(sha256) {
      // a stored package in the pre-0.1.0 format -> extension.legacy_format
      const pkg = await readExtensionPackage(await blobs.get(sha256), {
        maxBytes: config.packages.maxBytes,
        hostSdkVersion: SDK_VERSION,
      }).catch((e: unknown) => {
        throw e instanceof ExtensionPackageError ? extensionPackageApiError(e) : e;
      });
      return permissionSetOfPackage(pkg);
    },
    async publishChanged(plugin) {
      try {
        await bus.publish(PLUGINS_CHANGED_TOPIC, { plugin });
        return true;
      } catch (err) {
        log.warn(
          "cannot publish plugins.changed; running replicas pick the change up on their next periodic reconcile",
          { plugin, err },
        );
        return false;
      }
    },
    close,
  };
}
