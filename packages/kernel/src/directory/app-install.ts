import { randomUUID } from "node:crypto";
import {
  type AppManifest,
  type Connector,
  EXTENSION_POINTS,
  type ExtensionManifest,
  type Logger,
  parseExtensionPoint,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import { normalizeToolRef } from "../agents/definition.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { OrgExtensionConfigs } from "../extensions/org-config.js";
import { audit } from "../identity/audit.js";
import { lockOrg } from "../orgs/org-lock.js";
import type { SkillsService } from "../skills/skills.service.js";
import type { StorageService } from "../storage/storage.service.js";
import type { ConnectorsService } from "../tools/connectors.service.js";
import {
  appPluginPlan,
  appPluginsNotDeployed,
  INSTALL_ACTIONS,
  lockOrgForActions,
  readAppManifest,
  readDirectoryFiles,
  skillOf,
  type TemplateDeps,
  templateConnectorInput,
} from "./org-directory.service.js";
import {
  assertItemInstallable,
  type DirectoryRequestsService,
  disabledPluginItems,
  pluginItemDisabled,
} from "./requests.service.js";

type Trx = Transaction<KernelDatabase>;

/** 组织安装应用时填的部分。 */
export interface AppInstallInput {
  connectors: Record<
    string /* templateId */,
    {
      name?: string;
      slug?: string;
      /** 只限模板 `editableEndpoint` 列出的路径。 */
      endpoint?: Record<string, unknown>;
      credential?: Record<string, unknown>;
      client?: { clientId: string; clientSecret?: string };
    }
  >;
  /** 插件的组织级配置（只用于本次新启用的插件）。 */
  pluginConfigs?: Record<string /* 插件名 */, Record<string, unknown>>;
}

export type ComponentKind = "plugin" | "connector" | "skill";

/** 安装时跳过的可选部分：没装到部署 / 版本不满足 / 插件条目被禁用的可选插件，以及用这些插件的连接器模板。 */
export interface AppInstallSkipped {
  plugins: string[];
  connectorTemplates: string[];
}

export interface UninstallReport {
  removed: { kind: ComponentKind; ref: string }[];
  kept: {
    kind: ComponentKind;
    ref: string;
    reason:
      | "pre_existing"
      | "used_by_agents"
      | "used_by_other_install"
      | "used_by_connectors"
      | "used_by_plugins";
  }[];
}

/** 应用安装（`GET /orgs/:orgId/app-installs`）。 */
export interface AppInstallView {
  id: string;
  itemId: string;
  name: string;
  version: string;
  status: "installing" | "installed" | "failed" | "uninstalling";
  installedBy: string | null;
  installedAt: string;
  error: { step: string; code: string } | null;
  components: { kind: ComponentKind; ref: string; created: boolean; skillVersion: number | null }[];
}

export interface AppInstallerDeps {
  db: KernelDb;
  storage: StorageService;
  host: Pick<ExtensionHost, "manifests" | "list">;
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  connectors: Pick<ConnectorsService, "create" | "removeIn">;
  skills: Pick<SkillsService, "createVersionFromFiles" | "softDeleteIn" | "revertVersionIn">;
  orgConfigs: Pick<OrgExtensionConfigs, "put" | "disableIn" | "afterDisable" | "enabledDependents">;
  requests: Pick<DirectoryRequestsService, "resolveByInstall">;
  /** `directory.staleInstallMinutes`：installing 超过这么久可以经卸载清理。 */
  staleInstallMinutes: () => number;
  log?: Pick<Logger, "warn">;
}

interface Component {
  kind: ComponentKind;
  ref: string;
  created: boolean;
  skillVersion: number | null;
}

type Step = "plugins" | "connectors" | "skills";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const installNotFound = () => new ApiError("app.install_not_found", "App install not found");
const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);
const isUniqueViolation = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

/**
 * 应用的组织安装与卸载（C31）。安装依次：在本组织启用插件（已启用的记 created=false；按应用条目的策略，不看各插件
 * 条目，C22）→ 按模板建连接器（凭据 / 客户端写 secrets，默认策略记 `policy_source 'template'`）→ 导入技能（同名组织
 * 技能新增版本，记 created=false 与 skill_version）。每个组件建好就记进 `app_install_components`；任一步失败按相反顺序
 * 撤销本次新建的组件，安装记 failed（error 只含步骤与错误码），抛 502 `app.install_failed`。
 * 卸载只移除 created=true 且别处不在用的组件，保留项与原因写进报告。无进程内状态；组织行锁串行化同一组织的写。
 */
export class AppInstaller {
  constructor(private readonly d: AppInstallerDeps) {}

  async install(
    orgId: string,
    actor: string,
    itemId: string,
    version: string,
    input: AppInstallInput,
    opts: { actorTokenId?: string } = {},
  ): Promise<{ installId: string; skipped: AppInstallSkipped }> {
    const v = await this.d.db
      .selectFrom("directory_item_versions as v")
      .innerJoin("directory_items as i", "i.id", "v.item_id")
      .select(["i.name", "i.kind", "v.object_prefix", "v.files", "v.version"])
      .where("v.item_id", "=", itemId)
      .where("v.version", "=", version)
      .where("i.deleted_at", "is", null)
      .executeTakeFirst();
    if (v?.kind !== "app") {
      throw new ApiError("directory.item_not_found", "App version not found");
    }
    const manifest = await readAppManifest(this.d.storage, v);
    const { plugins, skipped } = await this.planPlugins(orgId, manifest);
    this.checkInput(manifest, input);

    // 建安装记录（锁内复核角色与应用条目策略；同一组织同一应用只能有一个未失败的安装）
    const installId = randomUUID();
    await this.d.db.transaction().execute(async (t) => {
      await lockOrgForActions(t, orgId, actor, INSTALL_ACTIONS.app);
      await assertItemInstallable(t, orgId, itemId);
      const live = await t
        .selectFrom("app_installs")
        .select("id")
        .where("org_id", "=", orgId)
        .where("item_id", "=", itemId)
        .where("status", "<>", "failed")
        .executeTakeFirst();
      if (live) throw alreadyInstalled();
      try {
        await t
          .insertInto("app_installs")
          .values({
            id: installId,
            org_id: orgId,
            item_id: itemId,
            version,
            status: "installing",
            installed_by: actor,
          })
          .execute();
      } catch (e) {
        if (isUniqueViolation(e)) throw alreadyInstalled();
        throw e;
      }
    });

    const done: Component[] = [];
    // 在给定事务里记组件（安装记录已被清理时外键失败 → 整个安装中止并回滚）
    const record = async (c: Component, t?: Trx) => {
      // 先记进 done：记录失败时已建好的组件照样回滚（插件的启用与记录同一事务，失败则一起撤销）
      done.push(c);
      await (t ?? this.d.db)
        .insertInto("app_install_components")
        .values({
          install_id: installId,
          kind: c.kind,
          ref: c.ref,
          created: c.created,
          skill_version: c.skillVersion,
        })
        .onConflict((oc) => oc.columns(["install_id", "kind", "ref"]).doNothing())
        .execute();
    };
    let step: Step = "plugins";
    try {
      for (const p of plugins) {
        // 「之前就启用」在组织行锁内判定（已启用时 put 什么都不写，配置也不动），组件在同一事务里记下
        const holder = { skipped: false };
        const config = input.pluginConfigs?.[p];
        await this.d.orgConfigs.put(
          orgId,
          p,
          { enabled: true, ...(config !== undefined && { config }) },
          actor,
          opts.actorTokenId,
          {
            viaItem: itemId,
            ifDisabled: holder,
            inTransaction: (t, skipped) =>
              record({ kind: "plugin", ref: p, created: !skipped, skillVersion: null }, t),
          },
        );
      }
      step = "connectors";
      for (const ct of manifest.connectorTemplates) {
        if (skipped.connectorTemplates.includes(ct.id)) continue;
        const r = await this.d.connectors.create(
          orgId,
          actor,
          templateConnectorInput(
            this.templateDeps(),
            ct.template,
            { itemId, version, templateId: ct.id },
            input.connectors[ct.id],
            ct.displayName.en,
            `app.connectors.${ct.id}`,
          ),
          opts.actorTokenId,
        );
        await record({ kind: "connector", ref: r.connector.id, created: true, skillVersion: null });
      }
      step = "skills";
      for (const s of manifest.skills) {
        const files = await readDirectoryFiles(this.d.storage, v.object_prefix, v.files, s.path);
        const r = await this.d.skills.createVersionFromFiles(
          orgId,
          actor,
          { ...skillOf(files), files },
          { directory: { itemId, version }, ...opts },
        );
        await record({
          kind: "skill",
          ref: r.skill.id,
          created: r.created,
          skillVersion: r.created ? null : r.version,
        });
      }
      await this.d.db.transaction().execute(async (t) => {
        await lockOrg(t, orgId);
        const updated = await t
          .updateTable("app_installs")
          .set({ status: "installed" })
          .where("id", "=", installId)
          .where("status", "=", "installing")
          .executeTakeFirst();
        // 安装记录已被当作超时清理掉：不写 app.installed，走失败回滚
        if (updated.numUpdatedRows === 0n) {
          throw new ApiError(
            "app.install_not_found",
            "The install record was cleaned up as stale while the install was running",
          );
        }
        await this.d.requests.resolveByInstall(t, orgId, itemId, actor, opts);
        await audit(t, {
          actorAccountId: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          orgId,
          action: "app.installed",
          target: installId,
          detail: { itemId, name: v.name, version, components: done, skipped },
        });
      });
      return { installId, skipped };
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "internal";
      const rollbackErrors = await this.rollback(orgId, actor, installId, done);
      await this.d.db.transaction().execute(async (t) => {
        await t
          .updateTable("app_installs")
          .set({ status: "failed", error: JSON.stringify({ step, code }) })
          .where("id", "=", installId)
          .execute();
        await audit(t, {
          actorAccountId: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          orgId,
          action: "app.install_failed",
          target: installId,
          detail: { itemId, name: v.name, version, step, code, rolledBack: done, rollbackErrors },
        });
      });
      throw new ApiError(
        "app.install_failed",
        `Installing the app failed at step ${step} (${code}); the components it created were removed`,
        [
          {
            step,
            code,
            ...(e instanceof ApiError && { message: e.message }),
            ...(e instanceof ApiError && e.details !== undefined && { causeDetails: e.details }),
            rolledBack: rollbackErrors.length === 0,
          },
        ],
      );
    }
  }

  /** 查连接器插件与版本用的依赖（本副本此刻加载的）。 */
  private templateDeps(): TemplateDeps {
    const versions = new Map(this.d.host.manifests().map((m) => [m.name, m.version]));
    return { findConnector: this.d.findConnector, pluginVersion: (n) => versions.get(n) };
  }

  /**
   * 要启用的插件（按 requires 排序：本组织要用的能力的提供方在前），与列表同一套判定（{@link appPluginPlan}）：
   * - 必选插件没装到部署或加载的版本不满足范围 → `directory.not_deployed`（点名版本，M-4）；
   * - 本组织还没启用、插件自己的目录条目被禁用的必选插件 → `directory.item_disabled`（点名插件；插件条目 disabled 是
   *   总开关，应用也不能新启用它，裁决 M-5）；已启用的不受影响；
   * - 可选插件遇到以上情况 → 跳过，用到它的连接器模板也跳过（M-3），都写进结果。
   */
  private async planPlugins(
    orgId: string,
    manifest: AppManifest,
  ): Promise<{ plugins: string[]; skipped: AppInstallSkipped }> {
    const manifests = new Map(this.d.host.manifests().map((m) => [m.name, m]));
    const names = manifest.plugins.map((p) => p.name);
    const enabled = new Set(
      names.length === 0
        ? []
        : (
            await this.d.db
              .selectFrom("extension_org_configs")
              .select("plugin")
              .where("org_id", "=", orgId)
              .where("enabled", "=", true)
              .where("plugin", "in", names)
              .execute()
          ).map((r) => r.plugin),
    );
    const killed = new Set(
      (await disabledPluginItems(this.d.db, names)).filter((n) => !enabled.has(n)),
    );
    const plan = appPluginPlan(
      manifest.plugins.map((p) => ({ name: p.name, range: p.version, optional: p.optional })),
      new Map([...manifests].map(([n, m]) => [n, m.version])),
      killed,
    );
    if (plan.missing.length > 0) throw appPluginsNotDeployed(plan.missing);
    if (plan.disabled.length > 0) throw pluginItemDisabled(plan.disabled);
    const skippedPlugins = new Set(plan.skipped);
    const templates = manifest.connectorTemplates
      .filter((ct) => skippedPlugins.has(ct.template.plugin))
      .map((ct) => ct.id);
    return {
      plugins: orderByRequires(plan.use.map((n) => manifests.get(n) as ExtensionManifest)),
      skipped: { plugins: plan.skipped, connectorTemplates: templates },
    };
  }

  /** 输入只认清单里的模板 id 与插件名。 */
  private checkInput(manifest: AppManifest, input: AppInstallInput): void {
    const ids = new Set(manifest.connectorTemplates.map((c) => c.id));
    for (const k of Object.keys(input.connectors ?? {})) {
      if (!ids.has(k)) throw fail(`app.connectors.${k}`, "No such connector template in this app");
    }
    const names = new Set(manifest.plugins.map((p) => p.name));
    for (const k of Object.keys(input.pluginConfigs ?? {})) {
      if (!names.has(k)) throw fail(`app.pluginConfigs.${k}`, "No such plugin in this app");
    }
  }

  /**
   * 按相反顺序撤销本次新建的组件（不再复核角色：撤销的是本次安装自己的改动）；返回撤销失败的组件。
   * 撤销成功（或组件已不在）的组件行在同一事务里删掉：之后清理 failed 安装只处理撤销失败或保留下来的组件，
   * 不会把组织管理员之后手动重新启用的插件、用户之后新传的技能版本再撤销一遍。
   */
  private async rollback(
    orgId: string,
    actor: string,
    installId: string,
    done: Component[],
  ): Promise<{ kind: ComponentKind; ref: string }[]> {
    const errors: { kind: ComponentKind; ref: string }[] = [];
    for (const c of [...done].reverse()) {
      if (!c.created && c.skillVersion === null) continue;
      try {
        const removed = await this.d.db.transaction().execute(async (t) => {
          await lockOrg(t, orgId);
          // 别的已启用插件依赖它（本组织里只有它提供所需能力）：保留，不让它们失去依赖
          if (
            c.kind === "plugin" &&
            (await this.d.orgConfigs.enabledDependents(t, orgId, c.ref)).length > 0
          ) {
            return false;
          }
          const r = await this.removeComponent(t, orgId, actor, c, "app_install_rollback");
          await t
            .deleteFrom("app_install_components")
            .where("install_id", "=", installId)
            .where("kind", "=", c.kind)
            .where("ref", "=", c.ref)
            .execute();
          return r;
        });
        if (removed && c.kind === "plugin") await this.d.orgConfigs.afterDisable(orgId, c.ref);
      } catch (e) {
        errors.push({ kind: c.kind, ref: c.ref });
        this.d.log?.warn("app install rollback step failed", {
          orgId,
          kind: c.kind,
          ref: c.ref,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return errors;
  }

  /** 移除一个组件（已经不在的不报错）；返回是否真的改了东西。 */
  private async removeComponent(
    t: Trx,
    orgId: string,
    actor: string,
    c: Component,
    reason: string,
  ): Promise<boolean> {
    if (c.kind === "plugin") {
      return this.d.orgConfigs.disableIn(t, orgId, c.ref, actor, reason);
    }
    if (c.kind === "connector") {
      const live = await t
        .selectFrom("connectors")
        .select("id")
        .where("id", "=", c.ref)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!live) return false;
      await this.d.connectors.removeIn(t, orgId, c.ref, actor, undefined, reason);
      return true;
    }
    if (c.created) return this.d.skills.softDeleteIn(t, orgId, c.ref, actor, reason);
    if (c.skillVersion !== null) {
      return this.d.skills.revertVersionIn(t, orgId, c.ref, c.skillVersion, actor, reason);
    }
    return false;
  }

  /**
   * 卸载（`org.plugins.manage` + `connectors.manage` + `skills.manage`，组织行锁内复核，一个事务）。只移除 created=true 的组件：
   * - 技能：被 agent 选中（used_by_agents）或本组织别的应用安装也用到（used_by_other_install）时保留；
   * - 连接器：被 agent 引用时保留（used_by_agents）；
   * - 插件：别的应用安装也用到（used_by_other_install）、仍有连接器用它提供的连接器（used_by_connectors）、别的已启用
   *   插件依赖它（used_by_plugins）时保留；
   * - 之前就有的组件保留（pre_existing）。
   * 因 used_by_other_install 保留时把所有权交给最早的那个仍在的安装（它的组件行改为 created=true），卸载顺序不影响最终结果。
   * 删除安装记录，审计 `app.uninstalled`（detail 含 removed / kept）。可以卸载：installed；failed（已回滚，清记录与残留）；
   * 超过 `directory.staleInstallMinutes` 仍是 installing 的（副本中途崩溃）——后两种按回滚清理（已有技能上新增的版本也退回）。
   * 仍在安装中的 → `app.install_in_progress`。
   */
  async uninstall(
    orgId: string,
    actor: string,
    installId: string,
    opts: { actorTokenId?: string } = {},
  ): Promise<UninstallReport> {
    if (!UUID_RE.test(installId)) throw installNotFound();
    const report: UninstallReport = { removed: [], kept: [] };
    const staleMinutes = this.d.staleInstallMinutes();
    await this.d.db.transaction().execute(async (t) => {
      await lockOrgForActions(t, orgId, actor, INSTALL_ACTIONS.app);
      const row = await t
        .selectFrom("app_installs as a")
        .innerJoin("directory_items as i", "i.id", "a.item_id")
        .select([
          "a.id",
          "a.item_id",
          "a.version",
          "a.status",
          "i.name",
          sql<boolean>`a.installed_at < now() - make_interval(mins => ${staleMinutes})`.as("stale"),
        ])
        .where("a.id", "=", installId)
        .where("a.org_id", "=", orgId)
        .forUpdate("a")
        .executeTakeFirst();
      if (!row) throw installNotFound();
      if (row.status === "uninstalling" || (row.status === "installing" && !row.stale)) {
        throw new ApiError(
          "app.install_in_progress",
          `This app install is still in progress; it can be cleaned up after ${staleMinutes} minutes`,
        );
      }
      // failed（已回滚）与超时的 installing（副本中途崩溃）按回滚清理
      const rollbackMode = row.status !== "installed";
      const comps = await t
        .selectFrom("app_install_components")
        .select(["kind", "ref", "created", "skill_version"])
        .where("install_id", "=", installId)
        .execute();
      // 技能 → 连接器 → 插件；插件按 requires 的逆序（依赖方先于提供方），提供方检查时依赖方已处理完
      const pluginOrder = this.uninstallPluginOrder(
        comps.filter((c) => c.kind === "plugin").map((c) => c.ref),
      );
      const rank = (c: { kind: ComponentKind; ref: string }) =>
        c.kind === "skill" ? 0 : c.kind === "connector" ? 1 : 2 + pluginOrder.indexOf(c.ref);
      comps.sort((a, b) => rank(a) - rank(b));
      const agentRefs = await this.agentRefs(t, orgId);
      for (const c of comps) {
        const keep = (reason: UninstallReport["kept"][number]["reason"]) =>
          report.kept.push({ kind: c.kind, ref: c.ref, reason });
        const comp: Component = {
          kind: c.kind,
          ref: c.ref,
          created: c.created,
          skillVersion: c.skill_version,
        };
        if (!c.created) {
          // 回滚清理：已有技能上本次新增的版本退回；其余之前就有的保留
          if (
            rollbackMode &&
            c.kind === "skill" &&
            c.skill_version !== null &&
            (await this.removeComponent(t, orgId, actor, comp, "app_install_cleanup"))
          ) {
            report.removed.push({ kind: c.kind, ref: c.ref });
            continue;
          }
          keep("pre_existing");
          continue;
        }
        if (c.kind === "skill" && agentRefs.skills.has(c.ref)) {
          keep("used_by_agents");
          continue;
        }
        if (c.kind === "connector" && agentRefs.connectors.has(c.ref)) {
          keep("used_by_agents");
          continue;
        }
        if (c.kind !== "connector") {
          const heir = await t
            .selectFrom("app_install_components as c")
            .innerJoin("app_installs as a", "a.id", "c.install_id")
            .select("a.id")
            .where("a.org_id", "=", orgId)
            .where("a.id", "<>", installId)
            .where("a.status", "in", ["installing", "installed"])
            .where("c.kind", "=", c.kind)
            .where("c.ref", "=", c.ref)
            .orderBy("a.installed_at")
            .orderBy("a.id")
            .executeTakeFirst();
          if (heir) {
            // 交接所有权：仍在用它的最早安装接手（created=true），卸载它时照常移除，卸载顺序不影响结果
            await t
              .updateTable("app_install_components")
              .set({ created: true })
              .where("install_id", "=", heir.id)
              .where("kind", "=", c.kind)
              .where("ref", "=", c.ref)
              .execute();
            keep("used_by_other_install");
            continue;
          }
        }
        if (c.kind === "plugin") {
          const kinds = this.connectorKindsOf(c.ref);
          if (kinds.length > 0) {
            const used = await t
              .selectFrom("connectors")
              .select("id")
              .where("org_id", "=", orgId)
              .where("deleted_at", "is", null)
              .where("connector", "in", kinds)
              .executeTakeFirst();
            if (used) {
              keep("used_by_connectors");
              continue;
            }
          }
          if ((await this.d.orgConfigs.enabledDependents(t, orgId, c.ref)).length > 0) {
            keep("used_by_plugins");
            continue;
          }
        }
        const reason = rollbackMode ? "app_install_cleanup" : "app_uninstall";
        if (await this.removeComponent(t, orgId, actor, comp, reason)) {
          report.removed.push({ kind: c.kind, ref: c.ref });
        }
      }
      await t.deleteFrom("app_installs").where("id", "=", installId).execute();
      await audit(t, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        orgId,
        action: "app.uninstalled",
        target: installId,
        detail: {
          itemId: row.item_id,
          name: row.name,
          version: row.version,
          status: row.status,
          removed: report.removed,
          kept: report.kept,
        },
      });
    });
    for (const r of report.removed) {
      if (r.kind === "plugin") await this.d.orgConfigs.afterDisable(orgId, r.ref);
    }
    return report;
  }

  /** 卸载时插件的处理顺序：安装顺序（提供方在前）的逆序；本副本没加载的插件排在最后。 */
  private uninstallPluginOrder(refs: string[]): string[] {
    const loaded = new Map(this.d.host.manifests().map((m) => [m.name, m]));
    const known = refs.filter((r) => loaded.has(r)).map((r) => loaded.get(r) as ExtensionManifest);
    return [...orderByRequires(known).reverse(), ...refs.filter((r) => !loaded.has(r))];
  }

  /** 本组织的应用安装（含失败的），新的在前。 */
  async list(orgId: string): Promise<AppInstallView[]> {
    const rows = await this.d.db
      .selectFrom("app_installs as a")
      .innerJoin("directory_items as i", "i.id", "a.item_id")
      .select([
        "a.id",
        "a.item_id",
        "i.name",
        "a.version",
        "a.status",
        "a.installed_by",
        "a.installed_at",
        "a.error",
      ])
      .where("a.org_id", "=", orgId)
      .orderBy("a.installed_at", "desc")
      .orderBy("a.id")
      .execute();
    if (rows.length === 0) return [];
    const comps = await this.d.db
      .selectFrom("app_install_components")
      .select(["install_id", "kind", "ref", "created", "skill_version"])
      .where(
        "install_id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      name: r.name,
      version: r.version,
      status: r.status,
      installedBy: r.installed_by,
      installedAt: r.installed_at.toISOString(),
      error: (r.error as AppInstallView["error"]) ?? null,
      components: comps
        .filter((c) => c.install_id === r.id)
        .map((c) => ({
          kind: c.kind,
          ref: c.ref,
          created: c.created,
          skillVersion: c.skill_version,
        })),
    }));
  }

  /** 插件提供的连接器 kind（本副本已加载的 `connector@1` 实现）。 */
  private connectorKindsOf(plugin: string): string[] {
    return this.d.host
      .list("connector")
      .filter((e) => e.plugin === plugin)
      .map((e) => (e.impl as Connector | undefined)?.kind)
      .filter((k): k is string => typeof k === "string");
  }

  /** 本组织未删除 agent 的当前定义引用的连接器与组织技能。 */
  private async agentRefs(
    t: Trx,
    orgId: string,
  ): Promise<{ connectors: Set<string>; skills: Set<string> }> {
    const rows = await t
      .selectFrom("agents as a")
      .innerJoin("agent_versions as v", (j) =>
        j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
      )
      .select("v.definition")
      .where("a.org_id", "=", orgId)
      .where("a.deleted_at", "is", null)
      .execute();
    const connectors = new Set<string>();
    const skills = new Set<string>();
    for (const r of rows) {
      const def = r.definition as {
        tools?: unknown[];
        skills?: { orgSkills?: unknown[] };
      } | null;
      for (const ref of def?.tools ?? []) {
        const n = normalizeToolRef(ref) as { kind?: unknown; connectorId?: unknown };
        if (n?.kind === "connector" && typeof n.connectorId === "string") {
          connectors.add(n.connectorId);
        }
      }
      for (const s of def?.skills?.orgSkills ?? []) if (typeof s === "string") skills.add(s);
    }
    return { connectors, skills };
  }
}

const alreadyInstalled = () =>
  new ApiError(
    "app.already_installed",
    "This app is already installed in this organization; uninstall it before installing again",
  );

/** 按 requires 排序：插件要用的按组织启用的能力，由集合里的别的插件提供时，提供方在前；环则保持原顺序。 */
function orderByRequires(set: ExtensionManifest[]): string[] {
  const orgScoped = (ref: string) =>
    EXTENSION_POINTS[parseExtensionPoint(ref).name]?.orgScoped === true;
  const placed: string[] = [];
  const rest = [...set];
  while (rest.length > 0) {
    const idx = rest.findIndex((m) =>
      (m.requires ?? []).filter(orgScoped).every((ref) => {
        const providers = rest.filter(
          (o) => o.name !== m.name && o.provides.includes(ref as never),
        );
        return providers.length === 0;
      }),
    );
    const [next] = rest.splice(idx === -1 ? 0 : idx, 1);
    placed.push((next as ExtensionManifest).name);
  }
  return placed;
}
