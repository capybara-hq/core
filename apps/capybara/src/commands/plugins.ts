import {
  createDb,
  diffPermissions,
  type InspectedPlugin,
  KERNEL_MIGRATIONS_DIR,
  KERNEL_SCHEMA,
  type KernelConfig,
  KernelConfigSchema,
  type KernelLogger,
  kernelDb,
  loadConfig,
  migrate,
  type PendingPlugin,
  PluginApprovals,
  PluginHost,
  permissionKeys,
  planApprovals,
  secretValues,
} from "@capybara-hq/kernel";
import { type PasswordInput, readLine } from "./admin-create.js";

/** plugins 命令的输入输出流（测试可替换）。 */
export interface PluginsIo {
  stdin: PasswordInput;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const defaultIo = (): PluginsIo => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 共用准备：加载配置 → 跑内核迁移（幂等，快照表在其中）→ 导入并检查已配置插件（不调用 setup、不连 Redis）
 * → 读已批准快照。只连 PG。
 */
async function withReview<T>(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  fn: (r: {
    config: KernelConfig;
    plugins: InspectedPlugin[];
    approvals: PluginApprovals;
    snapshots: Awaited<ReturnType<PluginApprovals["all"]>>;
  }) => Promise<T>,
): Promise<T> {
  const config = await loadConfig(env);
  log.addSecrets(secretValues(KernelConfigSchema, config));
  log.setLevel(config.log.level);
  const connectTimeoutMs = config.db.connectTimeoutMs;
  await migrate(
    config.db.url,
    { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
    { connectTimeoutMs },
  );
  const plugins = await PluginHost.inspect(config.plugins);
  const raw = createDb(config.db.url, 2, (err) => log.error("pg idle client error", { err }), {
    connectTimeoutMs,
  });
  try {
    const approvals = new PluginApprovals(kernelDb(raw));
    return await fn({ config, plugins, approvals, snapshots: await approvals.all() });
  } finally {
    await raw.destroy().catch(() => {});
  }
}

/** 一个待批准插件的说明行（含新增 / 减少的权限项）。 */
function describePending(p: PendingPlugin): string[] {
  if (p.reason === "dependency") {
    const why = (p.blockedBy ?? [])
      .map((b) => `${b.capability} (provided only by ${b.providers.join(", ")})`)
      .join("; ");
    return [`${p.plugin} ${p.version}: not loaded: requires ${why}, awaiting approval`];
  }
  const head =
    p.reason === "new"
      ? `${p.plugin} ${p.version}: awaiting approval (new plugin)`
      : `${p.plugin} ${p.version}: awaiting approval (permissions added since the approved snapshot)`;
  return [head, ...p.added.map((k) => `  + ${k}`), ...p.removed.map((k) => `  - ${k}`)];
}

/**
 * `capybara plugins review`：列出待批准的插件（与内核启动时的判断相同）及其新增 / 减少的权限项。
 * 退出码：0 成功 / 1 失败。
 */
export async function runPluginsReview(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  try {
    return await withReview(log, env, async ({ config, plugins, snapshots }) => {
      const sets = new Map(plugins.map((p) => [p.manifest.name, p.permissions]));
      const pending = planApprovals(
        plugins.map((p) => p.manifest),
        sets,
        snapshots,
      ).flatMap((d) => (d.action === "pending" ? [d.pending] : []));
      const out: string[] = [];
      if (pending.length === 0) out.push("No plugins await permission approval.");
      else {
        for (const p of pending) out.push(...describePending(p));
        out.push("", "Approve with: capybara plugins approve <name>, then restart the kernel.");
      }
      if (config.pluginPermissions.autoApprove) {
        out.push(
          "Note: pluginPermissions.autoApprove is on; the kernel approves plugin permissions automatically at startup.",
        );
      }
      io.stdout.write(`${out.join("\n")}\n`);
      return 0;
    });
  } catch (e) {
    io.stderr.write(`capybara: plugins review failed: ${errMsg(e)}\n`);
    return 1;
  }
}

/**
 * `capybara plugins approve <name>`：展示插件当前的完整权限（新增项标 `+`、减少项标 `-`），
 * 终端确认（`--yes` 跳过）后写入快照（source cli）并记审计 `plugin.permissions_approved`（无 actor）。
 * 内核在启动时读快照，批准后需重启内核生效。
 * 退出码：0 成功或无需批准 / 1 失败、未确认，或自身已批准但被待批准的依赖阻塞（输出阻塞的提供方）。
 */
export async function runPluginsApprove(
  opts: { name: string; yes: boolean },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  const fail = (msg: string) => {
    io.stderr.write(`capybara: plugins approve failed: ${msg}\n`);
    return 1;
  };
  try {
    return await withReview(log, env, async ({ plugins, approvals, snapshots }) => {
      const target = plugins.find((p) => p.manifest.name === opts.name);
      if (!target) {
        return fail(
          `plugin "${opts.name}" is not in the configured plugins (${plugins.map((p) => p.manifest.name).join(", ") || "none"})`,
        );
      }
      const { name, version } = target.manifest;
      const snap = snapshots.get(name);
      const { added, removed } = diffPermissions(snap?.permissions, target.permissions);
      if (snap && added.length === 0) {
        // 自身已批准但被依赖阻塞：点名阻塞它的提供方，退出码 1（批准它本身无济于事）
        const decision = planApprovals(
          plugins.map((p) => p.manifest),
          new Map(plugins.map((p) => [p.manifest.name, p.permissions])),
          snapshots,
        ).find((d) => d.plugin === name);
        if (decision?.action === "pending" && decision.pending.reason === "dependency") {
          const why = (decision.pending.blockedBy ?? [])
            .map((b) => `${b.capability} (provided only by ${b.providers.join(", ")})`)
            .join("; ");
          return fail(
            `${name} ${version} is already approved but is not loaded because it requires ${why}, which await approval; approve those plugins instead`,
          );
        }
        io.stdout.write(
          `${name} ${version} has no new permissions to approve (the kernel loads it and updates the snapshot when permissions shrink).\n`,
        );
        return 0;
      }
      const isNew = new Set(added);
      const lines = [
        `${name} ${version} ${snap ? `(approved: ${snap.version})` : "(not approved yet)"} requests:`,
        ...permissionKeys(target.permissions).map((k) => `  ${isNew.has(k) ? "+" : " "} ${k}`),
        ...removed.map((k) => `  - ${k}`),
      ];
      if (permissionKeys(target.permissions).length === 0) lines.push("  (no permissions)");
      io.stdout.write(`${lines.join("\n")}\n`);
      if (!opts.yes) {
        io.stdout.write(`Approve these permissions for ${name}? [y/N] `);
        const answer = (await readLine(io.stdin))?.trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.stdout.write("\nNot approved.\n");
          return 1;
        }
      }
      await approvals.approve(name, version, target.permissions, {
        source: "cli",
        audit: { added, removed },
      });
      log.info("plugin permissions approved", { plugin: name, version, added, removed });
      io.stdout.write(`Approved ${name} ${version}. Restart the kernel to apply.\n`);
      return 0;
    });
  } catch (e) {
    return fail(errMsg(e));
  }
}
