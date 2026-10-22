import { readFile } from "node:fs/promises";
import {
  type AdminPluginView,
  blockingKeys,
  diffPermissions,
  isSensitivePermissionKey,
  KERNEL_MIGRATIONS_DIR,
  KERNEL_SCHEMA,
  KernelConfigSchema,
  type KernelLogger,
  loadConfig,
  migrate,
  openPluginCli,
  type PendingPlugin,
  type PluginCli,
  permissionKeys,
  planApprovals,
  secretValues,
  withPreApproved,
} from "@capybara-hq/kernel";
import { BUILTIN_PLUGINS } from "../builtin-plugins.js";
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
 * 共用准备：加载配置 → 跑内核迁移（幂等，快照与安装记录表在其中）→ 导入并检查内置与已配置插件（不调用 setup）
 * → 打开 CLI 的插件管理上下文（只连 PG；发布 `kernel.plugins.changed` 时才连 Redis，连不上只告警）。
 */
async function withCli<T>(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  fn: (cli: PluginCli) => Promise<T>,
): Promise<T> {
  const config = await loadConfig(env);
  log.addSecrets(secretValues(KernelConfigSchema, config));
  log.setLevel(config.log.level);
  await migrate(
    config.db.url,
    { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
    { connectTimeoutMs: config.db.connectTimeoutMs },
  );
  const cli = await openPluginCli(config, log, { builtin: [...BUILTIN_PLUGINS] });
  try {
    return await fn(cli);
  } finally {
    await cli.close();
  }
}

/**
 * 内置与配置声明插件的快照：内置插件（C14）预先批准，补上与其当前权限相同的快照，因此不会出现在待批准里，
 * 依赖它们的插件照常判定。
 */
async function declaredSnapshots(cli: PluginCli) {
  return withPreApproved(
    await cli.approvals.all(),
    cli.inspected.filter((p) => p.source === "builtin").map((p) => p.manifest),
    new Map(cli.inspected.map((p) => [p.manifest.name, p.permissions])),
  );
}

/** 权限键加敏感标记（与组织启用页的敏感分组同一套规则，spec §5.4）。 */
const mark = (k: string): string => (isSensitivePermissionKey(k) ? `${k}  (sensitive)` : k);

/**
 * 依赖阻塞的说明：提供方都待批准时点名它们；没有任何提供方时（如声明了 `permissions.storage` 却没装
 * `object-store@1` 提供方）说明要先安装。
 */
function blockedByText(p: PendingPlugin): string {
  return (p.blockedBy ?? [])
    .map((b) =>
      b.providers.length > 0
        ? `${b.capability} (provided only by ${b.providers.join(", ")})`
        : `${b.capability} (no provider is installed; add a plugin that provides it)`,
    )
    .join("; ");
}

/** 一个待批准插件的说明行（含新增 / 减少的权限项）。 */
function describePending(p: PendingPlugin): string[] {
  if (p.reason === "dependency") {
    const waiting = (p.blockedBy ?? []).some((b) => b.providers.length > 0);
    return [
      `${p.plugin} ${p.version}: not loaded: requires ${blockedByText(p)}${waiting ? ", awaiting approval" : ""}`,
    ];
  }
  const head =
    p.reason === "new"
      ? `${p.plugin} ${p.version}: awaiting approval (new plugin)`
      : `${p.plugin} ${p.version}: awaiting approval (permissions added since the approved snapshot)`;
  return [head, ...p.added.map((k) => `  + ${mark(k)}`), ...p.removed.map((k) => `  - ${k}`)];
}

/** 安装记录（包读不到的除外）是否待批准：没有快照，或比快照多出需要批准的项（F-N：与期望状态无关）。 */
const installPending = (v: AdminPluginView): boolean =>
  v.error === undefined && (v.snapshot === null || blockingKeys(v.added).length > 0);

/** CLI 读不到对象存储里的包（F-Q：CLI 不加载 object-store 插件）。 */
const OBJECT_STORE_HINT =
  "the package is kept in object storage, which the CLI cannot read; use the admin console";

/** 包读不到的说明（对象存储里的包换成可操作的提示）。 */
const unreadable = (v: AdminPluginView): string =>
  v.error?.includes("object storage is not available") ? OBJECT_STORE_HINT : (v.error ?? "");

/**
 * `capybara plugins review`：列出待批准的插件（配置声明的按内核启动时的判断，安装记录按包的权限与快照）
 * 及其新增 / 减少的权限项。退出码：0 成功 / 1 失败。
 */
export async function runPluginsReview(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  try {
    return await withCli(log, env, async (cli) => {
      const snapshots = await declaredSnapshots(cli);
      const sets = new Map(cli.inspected.map((p) => [p.manifest.name, p.permissions]));
      const pending = planApprovals(
        cli.inspected.map((p) => p.manifest),
        sets,
        snapshots,
      ).flatMap((d) => (d.action === "pending" ? [d.pending] : []));
      const out: string[] = [];
      for (const p of pending) out.push(...describePending(p));
      for (const v of await cli.admin.list()) {
        if (v.source !== "install") continue;
        if (v.error !== undefined) {
          out.push(`${v.name} ${v.version}: cannot review: ${unreadable(v)}`);
          continue;
        }
        if (!installPending(v)) continue;
        out.push(
          `${v.name} ${v.version}: awaiting approval (${v.snapshot ? "permissions added since the approved snapshot" : "new plugin"}; installed package ${v.sha256?.slice(0, 16)})`,
          ...v.added.map((k) => `  + ${mark(k)}`),
          ...v.removed.map((k) => `  - ${k}`),
        );
      }
      if (out.length === 0) out.push("No plugins await permission approval.");
      else out.push("", "Approve with: capybara plugins approve <name>");
      if (cli.config.pluginPermissions.autoApprove) {
        out.push(
          "Note: pluginPermissions.autoApprove is on; the kernel approves plugin permissions automatically.",
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
 * 终端确认（`--yes` 跳过）后写入快照（source cli）并记审计 `plugin.permissions_approved`（无 actor），
 * 然后发布 `kernel.plugins.changed`：运行中的副本据此加载，不需重启（发布失败时等下一个周期）。
 * 覆盖配置声明的插件与安装记录；内置插件预先批准。
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
    return await withCli(log, env, async (cli) => {
      const snapshots = await declaredSnapshots(cli);
      const target = cli.inspected.find((p) => p.manifest.name === opts.name);
      let name: string;
      let version: string;
      let permissions: Parameters<typeof permissionKeys>[0];
      let sha256: string | null = null;
      if (target) {
        ({ name, version } = target.manifest);
        permissions = target.permissions;
        if (target.source === "builtin") {
          io.stdout.write(
            `${name} ${version} is built into this deployment and pre-approved; it needs no approval.\n`,
          );
          return 0;
        }
      } else {
        const install = (await cli.installs.list()).find((r) => r.name === opts.name);
        if (!install) {
          const known = [
            ...cli.inspected.map((p) => p.manifest.name),
            ...(await cli.installs.list()).map((r) => r.name),
          ];
          return fail(
            `plugin "${opts.name}" is neither configured nor installed (${known.join(", ") || "none"})`,
          );
        }
        name = install.name;
        version = install.version;
        sha256 = install.sha256;
        try {
          permissions = await cli.packageSet(install.sha256);
        } catch (e) {
          return fail(
            `cannot read the package of ${name} ${version}: ${errMsg(e).includes("object storage is not available") ? OBJECT_STORE_HINT : errMsg(e)}`,
          );
        }
      }
      const snap = snapshots.get(name);
      const { added, removed } = diffPermissions(snap?.permissions, permissions);
      // 只多出视图（ui.view:*）不需要批准：内核加载时自动补进快照
      if (snap && blockingKeys(added).length === 0) {
        if (target) {
          // 自身已批准但被依赖阻塞：点名阻塞它的提供方，退出码 1（批准它本身无济于事）
          const decision = planApprovals(
            cli.inspected.map((p) => p.manifest),
            new Map(cli.inspected.map((p) => [p.manifest.name, p.permissions])),
            snapshots,
          ).find((d) => d.plugin === name);
          if (decision?.action === "pending" && decision.pending.reason === "dependency") {
            return fail(
              `${name} ${version} is already approved but is not loaded because it requires ${blockedByText(decision.pending)}; approve or install those providers instead`,
            );
          }
        }
        io.stdout.write(
          `${name} ${version} has no new permissions to approve (the kernel loads it and updates the snapshot when permissions shrink or only ui views are added).\n`,
        );
        return 0;
      }
      const isNew = new Set(added);
      const keys = permissionKeys(permissions);
      const lines = [
        `${name} ${version} ${snap ? `(approved: ${snap.version})` : "(not approved yet)"} requests:`,
        ...keys.map((k) => `  ${isNew.has(k) ? "+" : " "} ${mark(k)}`),
        ...removed.map((k) => `  - ${k}`),
      ];
      if (keys.length === 0) lines.push("  (no permissions)");
      io.stdout.write(`${lines.join("\n")}\n`);
      if (!opts.yes) {
        io.stdout.write(`Approve these permissions for ${name}? [y/N] `);
        const answer = (await readLine(io.stdin))?.trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.stdout.write("\nNot approved.\n");
          return 1;
        }
      }
      await cli.approvals.approve(name, version, permissions, {
        source: "cli",
        audit: { added, removed, ...(sha256 !== null && { sha256 }) },
      });
      log.info("plugin permissions approved", { plugin: name, version, added, removed });
      const sent = await cli.publishChanged(name);
      io.stdout.write(
        `Approved ${name} ${version}. ${sent ? "Running replicas load it without a restart." : "Running replicas pick it up on their next periodic reconcile (could not notify them now)."}\n`,
      );
      return 0;
    });
  } catch (e) {
    return fail(errMsg(e));
  }
}

/** 一行状态：名字、版本、来源、期望状态、部署级状态。 */
function listLine(v: AdminPluginView): string {
  const desired = v.desired ? v.desired.state : "always";
  const status = v.error !== undefined ? `unknown (${unreadable(v)})` : v.status;
  return [v.name, v.version, v.source, desired, status].join("\t");
}

/** `capybara plugins list`：部署上的全部插件（内置、配置声明、安装记录）及其状态。退出码：0 / 1。 */
export async function runPluginsList(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  try {
    return await withCli(log, env, async (cli) => {
      const views = await cli.admin.list();
      io.stdout.write(
        `${["NAME", "VERSION", "SOURCE", "DESIRED", "STATUS"].join("\t")}\n${views.map(listLine).join("\n")}${views.length > 0 ? "\n" : ""}`,
      );
      return 0;
    });
  } catch (e) {
    io.stderr.write(`capybara: plugins list failed: ${errMsg(e)}\n`);
    return 1;
  }
}

/** `install` 的目标：`npm:<包名>[@<版本>]` 或本地 tgz 文件。 */
export function parseInstallTarget(
  target: string,
): { kind: "npm"; package: string; version?: string } | { kind: "file"; path: string } {
  if (!target.startsWith("npm:")) return { kind: "file", path: target };
  const spec = target.slice(4);
  const at = spec.lastIndexOf("@");
  if (at > 0) return { kind: "npm", package: spec.slice(0, at), version: spec.slice(at + 1) };
  return { kind: "npm", package: spec };
}

/**
 * `capybara plugins install <file.tgz | npm:<name>[@<ver>]>`：校验并存入包（一律存 PG，F-Q），新装或换版本
 * （期望状态不变：新装为停用），审计 `plugin.installed`，然后发布 `kernel.plugins.changed`。
 * 新增权限需要 `capybara plugins approve <name>`，新装的插件需要 `capybara plugins enable <name>`。
 * 退出码：0 / 1。
 */
export async function runPluginsInstall(
  opts: { target: string },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  try {
    return await withCli(log, env, async (cli) => {
      const t = parseInstallTarget(opts.target);
      const bytes = t.kind === "file" ? new Uint8Array(await readFile(t.path)) : undefined;
      const review = bytes
        ? await cli.installs.ingestFile(null, bytes, { store: "pg" })
        : await cli.installs.ingestNpm(
            null,
            t.kind === "npm"
              ? { package: t.package, ...(t.version !== undefined && { version: t.version }) }
              : { package: "" },
            { store: "pg" },
          );
      if (bytes) cli.remember(review.sha256, bytes);
      const view = await cli.ops.install(review.name, review.sha256, null);
      const lines = [
        `Installed ${review.name} ${review.version} (package ${review.sha256.slice(0, 16)}; deployment state: ${view.desired?.state ?? "?"}; status: ${view.status}).`,
      ];
      if (review.added.length > 0 || review.removed.length > 0) {
        lines.push(
          "Permissions changed since the approved snapshot:",
          ...review.added.map((k) => `  + ${mark(k)}`),
          ...review.removed.map((k) => `  - ${k}`),
        );
      }
      if (review.warnings.length > 0) {
        lines.push(
          "Warning (sensitive): the package's migrations contain destructive statements; plugin migrations should only expand, because old and new versions run side by side during an upgrade:",
          ...review.warnings.map((w) => `  ! ${w.file}:${w.line}  ${w.statement}`),
        );
      }
      if (view.status === "pending_approval") {
        lines.push(`Approve with: capybara plugins approve ${review.name}`);
      }
      if (view.desired?.state === "disabled") {
        lines.push(`Enable with: capybara plugins enable ${review.name}`);
      }
      io.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    });
  } catch (e) {
    io.stderr.write(`capybara: plugins install failed: ${errMsg(e)}\n`);
    return 1;
  }
}

/**
 * `capybara plugins enable | disable | uninstall <name>`：改期望状态（卸载须先停用，数据保留），审计，
 * 发布 `kernel.plugins.changed`。退出码：0 / 1。
 */
export async function runPluginsState(
  opts: { name: string; action: "enable" | "disable" | "uninstall" },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  try {
    return await withCli(log, env, async (cli) => {
      if (opts.action === "uninstall") {
        await cli.ops.uninstall(opts.name, null);
        io.stdout.write(
          `Uninstalled ${opts.name}. Its data (database schema, secrets, organization settings) is kept.\n`,
        );
        return 0;
      }
      const view =
        opts.action === "enable"
          ? await cli.ops.enable(opts.name, null)
          : await cli.ops.disable(opts.name, null);
      io.stdout.write(
        `${opts.action === "enable" ? "Enabled" : "Disabled"} ${opts.name} ${view.version} (status: ${view.status}).\n`,
      );
      if (opts.action === "enable" && view.status === "pending_approval") {
        io.stdout.write(`It loads after approval: capybara plugins approve ${opts.name}\n`);
      }
      return 0;
    });
  } catch (e) {
    io.stderr.write(`capybara: plugins ${opts.action} failed: ${errMsg(e)}\n`);
    return 1;
  }
}
