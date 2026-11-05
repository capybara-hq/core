// Platform components (plugin scope phase 2, rulings A2 and C2): the skills, agent templates and
// connector templates of a catalog item, stored once for the deployment. Files live under
// `deployment/platform/{skills,agent-templates}/<id>/<version>/`, never under an org prefix (orgs
// are purged by prefix).
import { randomUUID } from "node:crypto";
import type { AgentTemplate, ConnectorTemplateFile, PluginManifest } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb, SkillManifest, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { packagePath } from "../packages/tgz.js";
import type { SkillPackageFile } from "../skills/package.js";
import { skillManifest } from "../skills/skills.service.js";
import { type PrefixedStorage, StorageService } from "../storage/storage.service.js";
import { canonicalJson } from "../tools/canonical-json.js";
import {
  type CatalogVersionFiles,
  readCatalogAgentTemplates,
  readCatalogFiles,
  readCatalogTemplates,
  skillFilesDigest,
  skillOf,
} from "./catalog-content.js";
import { putCatalogFiles } from "./catalog-items.js";
import { CatalogItemLock } from "./locks.js";

/** A skill or agent template version a sync wrote (`from` null: the component was created). */
export interface ChangedRef {
  kind: "skill" | "agent_template";
  id: string;
  name: string;
  from: number | null;
  to: number;
}

/**
 * A connector template a sync wrote. Connector templates carry the catalog version that last
 * changed them (`platform_connector_templates.current_version` is text), so `from` / `to` are
 * catalog versions; `name` is the template id (the file's base name).
 */
export interface ChangedConnectorTemplateRef {
  kind: "connector_template";
  id: string;
  name: string;
  from: string | null;
  to: string;
}

/** What {@link PlatformComponents.syncFromVersion} changed (unchanged components are not listed). */
export interface PlatformSyncResult {
  skills: ChangedRef[];
  agentTemplates: ChangedRef[];
  connectorTemplates: ChangedConnectorTemplateRef[];
}

/** The prefix (in `deployment/`) of a platform skill version's files. */
export const platformSkillPrefix = (id: string, version: number): string =>
  `platform/skills/${id}/${version}/`;

/** The prefix (in `deployment/`) of a platform agent template version's file. */
export const platformAgentTemplatePrefix = (id: string, version: number): string =>
  `platform/agent-templates/${id}/${version}/`;

/** The live component a plan was made against (absent: the plan creates it). */
interface Base<V> {
  id: string;
  version: V;
}

interface SkillStep {
  name: string;
  base: Base<number> | undefined;
  id: string;
  to: number;
  prefix: string;
  files: SkillPackageFile[];
  manifest: SkillManifest;
  suggestPinned: boolean;
}

interface TemplateStep {
  name: string;
  base: Base<number> | undefined;
  id: string;
  to: number;
  prefix: string;
  file: SkillPackageFile;
  template: AgentTemplate;
}

interface ConnectorTemplateStep {
  name: string;
  base: Base<string> | undefined;
  id: string;
  file: ConnectorTemplateFile;
}

/** A planned sync (see {@link PreparedSync}). */
export interface SyncPlan {
  itemId: string;
  plugin: string;
  version: string;
  sourceFormat: SourceFormat;
  skills: SkillStep[];
  agentTemplates: TemplateStep[];
  connectorTemplates: ConnectorTemplateStep[];
}

/** A component changed between the plan and its write (a concurrent sync): plan again. */
export class PlanStale extends Error {}

/**
 * A sync planned and its files copied ({@link PlatformComponents.prepareSync}), waiting for its rows
 * ({@link PlatformComponents.applySyncIn}). Opaque outside this module.
 */
export interface PreparedSync {
  readonly plan: SyncPlan;
}

/** Plans are retried this many times against concurrent syncs of the same item. */
const SYNC_ATTEMPTS = 3;

/**
 * Writes the platform rows of a catalog version's components. Called by the import confirm that
 * creates a catalog item (`initial`), and by the platform plugin update for a new version.
 */
@Injectable()
export class PlatformComponents {
  /** Where the files are read and written (the kernel's object storage; the CLI's own). */
  private files: PrefixedStorage;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(StorageService) storage: StorageService,
    @Inject(CatalogItemLock) private readonly itemLock: CatalogItemLock,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {
    this.files = storage;
  }

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** CLI only (see `PluginImport.useCliStorage`): files go to the object store the CLI set up. */
  useCliStorage(storage: PrefixedStorage): void {
    this.files = storage;
  }

  /**
   * Creates or updates the platform rows of every component of catalog version `version` of item
   * `itemId`: a component is matched by plugin and name (connector templates by item and template
   * id) and gets a new version only when its content changed (skills by their files' digest,
   * templates by canonical JSON); new rows follow the plugin's scope (`scope_mode: follow`).
   * Files are copied from the catalog prefix to `deployment/platform/…` before the rows are
   * written (outside the transaction), so a sync that stops midway leaves at most unreferenced
   * files, and running it again is a no-op once it succeeded. `initial` is the confirm that
   * created the item. Components missing from the version are left alone (the platform update
   * decides what a removal means). On success the item records `version` as
   * `platform_synced_version`.
   */
  async syncFromVersion(
    itemId: string,
    version: string,
    opts: { initial: boolean },
  ): Promise<PlatformSyncResult> {
    for (let attempt = 1; ; attempt++) {
      const plan = await this.plan(itemId, version);
      if (
        plan.skills.length === 0 &&
        plan.agentTemplates.length === 0 &&
        plan.connectorTemplates.length === 0
      ) {
        await this.markSynced(itemId, version);
        return { skills: [], agentTemplates: [], connectorTemplates: [] };
      }
      await this.writeFiles(plan);
      try {
        const r = await this.apply(plan);
        await this.markSynced(itemId, version);
        this.log.info("platform components synced", {
          itemId,
          version,
          initial: opts.initial,
          skills: r.skills.length,
          agentTemplates: r.agentTemplates.length,
          connectorTemplates: r.connectorTemplates.length,
        });
        return r;
      } catch (e) {
        if (!(e instanceof PlanStale) || attempt >= SYNC_ATTEMPTS) throw e;
      }
    }
  }

  /**
   * The first phase of a sync inside a caller's transaction (the platform plugin update): plans the
   * version's components and copies their files, outside any transaction (no storage call holds a
   * row lock). {@link applySyncIn} writes the rows.
   */
  async prepareSync(itemId: string, version: string): Promise<PreparedSync> {
    const plan = await this.plan(itemId, version);
    await this.writeFiles(plan);
    return { plan };
  }

  /**
   * The second phase: writes the prepared rows in the caller's transaction and records
   * `platform_synced_version`. A component changed since the plan -> {@link PlanStale} (the caller
   * prepares again).
   */
  @Transactional({ propagation: "mandatory" })
  async applySyncIn(p: PreparedSync): Promise<PlatformSyncResult> {
    const r = await this.apply(p.plan);
    await this.markSynced(p.plan.itemId, p.plan.version);
    return r;
  }

  /**
   * Records that the item's platform components are written from `version`
   * (`catalog_items.platform_synced_version`): the migration job syncs only items without it.
   */
  private async markSynced(itemId: string, version: string): Promise<void> {
    await this.db
      .updateTable("catalog_items")
      .set({ platform_synced_version: version })
      .where("id", "=", itemId)
      .execute();
  }

  /** Reads the version's components and the live platform rows; keeps only what changed. */
  private async plan(itemId: string, version: string): Promise<SyncPlan> {
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["name"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const row = item
      ? await this.db
          .selectFrom("catalog_item_versions")
          .select(["manifest", "object_prefix", "files", "source_format"])
          .where("item_id", "=", itemId)
          .where("version", "=", version)
          .executeTakeFirst()
      : undefined;
    if (!item || !row) {
      throw new ApiError("catalog.item_not_found", `Catalog item ${itemId}@${version} not found`);
    }
    const plugin = item.name;
    const manifest = row.manifest as PluginManifest;
    const v: CatalogVersionFiles = row;
    const plan: SyncPlan = {
      itemId,
      plugin,
      version,
      sourceFormat: row.source_format,
      skills: [],
      agentTemplates: [],
      connectorTemplates: [],
    };

    for (const s of manifest.skills ?? []) {
      const files = await readCatalogFiles(
        this.files,
        row.object_prefix,
        row.files,
        packagePath(s.path),
      );
      const pkg = { ...skillOf(files), files };
      const live = await this.db
        .selectFrom("platform_skills as p")
        .innerJoin("platform_skill_versions as pv", (j) =>
          j.onRef("pv.skill_id", "=", "p.id").onRef("pv.version", "=", "p.current_version"),
        )
        .select(["p.id", "p.current_version", "pv.manifest"])
        .where("p.plugin_name", "=", plugin)
        .where("p.name", "=", pkg.name)
        .where("p.deleted_at", "is", null)
        .executeTakeFirst();
      if (live && skillFilesDigest(live.manifest.files) === skillFilesDigest(files)) continue;
      const id = live?.id ?? randomUUID();
      const to = (live?.current_version ?? 0) + 1;
      plan.skills.push({
        name: pkg.name,
        base: live && { id: live.id, version: live.current_version },
        id,
        to,
        prefix: platformSkillPrefix(id, to),
        files,
        manifest: skillManifest(pkg),
        suggestPinned: s.pinned === true,
      });
    }

    const agents = await readCatalogAgentTemplates(this.files, v);
    for (const a of agents) {
      const live = await this.db
        .selectFrom("platform_agent_templates as p")
        .innerJoin("platform_agent_template_versions as pv", (j) =>
          j.onRef("pv.template_id", "=", "p.id").onRef("pv.version", "=", "p.current_version"),
        )
        .select(["p.id", "p.current_version", "pv.definition"])
        .where("p.plugin_name", "=", plugin)
        .where("p.name", "=", a.template.name)
        .where("p.deleted_at", "is", null)
        .executeTakeFirst();
      if (live && canonicalJson(live.definition) === canonicalJson(a.template)) continue;
      const [file] = await readCatalogFiles(
        this.files,
        row.object_prefix,
        row.files.filter((f) => f.path === a.path),
      );
      if (!file) throw new ApiError("internal", `Stored agent template ${a.path} is missing`);
      const id = live?.id ?? randomUUID();
      const to = (live?.current_version ?? 0) + 1;
      plan.agentTemplates.push({
        name: a.template.name,
        base: live && { id: live.id, version: live.current_version },
        id,
        to,
        prefix: platformAgentTemplatePrefix(id, to),
        file: { ...file, path: file.path.split("/").pop() as string },
        template: a.template,
      });
    }

    const templates = await readCatalogTemplates(this.files, v);
    for (const t of templates) {
      const live = await this.db
        .selectFrom("platform_connector_templates")
        .select(["id", "current_version", "file"])
        .where("catalog_item_id", "=", itemId)
        .where("template_id", "=", t.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (live && canonicalJson(live.file) === canonicalJson(t.file)) continue;
      plan.connectorTemplates.push({
        name: t.id,
        base: live && { id: live.id, version: live.current_version },
        id: live?.id ?? randomUUID(),
        file: t.file,
      });
    }
    return plan;
  }

  /** Copies the planned versions' files to their platform prefixes. */
  private async writeFiles(plan: SyncPlan): Promise<void> {
    if (plan.skills.length === 0 && plan.agentTemplates.length === 0) return;
    this.files.assertAvailable();
    for (const s of plan.skills) await putCatalogFiles(this.files, s.prefix, s.files);
    for (const a of plan.agentTemplates) await putCatalogFiles(this.files, a.prefix, [a.file]);
  }

  /**
   * Writes the planned rows under the item name's lock (the lock of the import confirm), after
   * checking that every component is still where the plan found it ({@link PlanStale} otherwise).
   */
  @Transactional()
  private async apply(plan: SyncPlan): Promise<PlatformSyncResult> {
    await this.itemLock.lock(plan.plugin);
    const t = this.db;
    const out: PlatformSyncResult = { skills: [], agentTemplates: [], connectorTemplates: [] };

    for (const s of plan.skills) {
      const live = await t
        .selectFrom("platform_skills")
        .select(["id", "current_version"])
        .where("plugin_name", "=", plan.plugin)
        .where("name", "=", s.name)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      assertBase(live && { id: live.id, version: live.current_version }, s.base);
      const description = s.manifest.description;
      if (live) {
        await t
          .updateTable("platform_skills")
          .set({
            current_version: s.to,
            description,
            catalog_item_id: plan.itemId,
            updated_at: new Date(),
          })
          .where("id", "=", s.id)
          .execute();
      } else {
        await t
          .insertInto("platform_skills")
          .values({
            id: s.id,
            catalog_item_id: plan.itemId,
            plugin_name: plan.plugin,
            name: s.name,
            description,
            description_zh: null,
            current_version: s.to,
            scope_mode: "follow",
          })
          .execute();
      }
      await t
        .insertInto("platform_skill_versions")
        .values({
          skill_id: s.id,
          version: s.to,
          manifest: JSON.stringify(s.manifest),
          object_prefix: s.prefix,
          catalog_version: plan.version,
          source_format: plan.sourceFormat,
          suggest_pinned: s.suggestPinned,
        })
        .execute();
      out.skills.push({
        kind: "skill",
        id: s.id,
        name: s.name,
        from: s.base?.version ?? null,
        to: s.to,
      });
    }

    for (const a of plan.agentTemplates) {
      const live = await t
        .selectFrom("platform_agent_templates")
        .select(["id", "current_version"])
        .where("plugin_name", "=", plan.plugin)
        .where("name", "=", a.name)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      assertBase(live && { id: live.id, version: live.current_version }, a.base);
      const description = a.template.description;
      if (live) {
        await t
          .updateTable("platform_agent_templates")
          .set({
            current_version: a.to,
            description,
            catalog_item_id: plan.itemId,
            updated_at: new Date(),
          })
          .where("id", "=", a.id)
          .execute();
      } else {
        await t
          .insertInto("platform_agent_templates")
          .values({
            id: a.id,
            catalog_item_id: plan.itemId,
            plugin_name: plan.plugin,
            name: a.name,
            description,
            current_version: a.to,
            scope_mode: "follow",
          })
          .execute();
      }
      await t
        .insertInto("platform_agent_template_versions")
        .values({
          template_id: a.id,
          version: a.to,
          definition: JSON.stringify(a.template),
          object_prefix: a.prefix,
          catalog_version: plan.version,
          source_format: plan.sourceFormat,
        })
        .execute();
      out.agentTemplates.push({
        kind: "agent_template",
        id: a.id,
        name: a.name,
        from: a.base?.version ?? null,
        to: a.to,
      });
    }

    for (const c of plan.connectorTemplates) {
      const live = await t
        .selectFrom("platform_connector_templates")
        .select(["id", "current_version"])
        .where("catalog_item_id", "=", plan.itemId)
        .where("template_id", "=", c.name)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      assertBase(live && { id: live.id, version: live.current_version }, c.base);
      if (live) {
        await t
          .updateTable("platform_connector_templates")
          .set({
            current_version: plan.version,
            file: JSON.stringify(c.file),
            updated_at: new Date(),
          })
          .where("id", "=", c.id)
          .execute();
      } else {
        await t
          .insertInto("platform_connector_templates")
          .values({
            id: c.id,
            catalog_item_id: plan.itemId,
            template_id: c.name,
            current_version: plan.version,
            file: JSON.stringify(c.file),
            scope_mode: "follow",
          })
          .execute();
      }
      out.connectorTemplates.push({
        kind: "connector_template",
        id: c.id,
        name: c.name,
        from: c.base?.version ?? null,
        to: plan.version,
      });
    }
    return out;
  }
}

/** The live row must still be the one the plan was made against. */
function assertBase<V>(live: Base<V> | undefined, base: Base<V> | undefined): void {
  if (live?.id !== base?.id || live?.version !== base?.version) throw new PlanStale();
}
