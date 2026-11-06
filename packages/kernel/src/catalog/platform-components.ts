// Platform components (plugin scope phase 2, rulings A2 and C2): the skills, agent templates and
// connector templates of a catalog item, stored once for the deployment. Files live under
// `deployment/platform/{skills,agent-templates}/<id>/<version>/`, never under an org prefix (orgs
// are purged by prefix).
import { createHash, randomUUID } from "node:crypto";
import {
  type AgentTemplate,
  type ConnectorTemplateFile,
  type PluginManifest,
  parseAgentTemplate,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb, SkillManifest, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { packagePath } from "../packages/tgz.js";
import { readSkillPackage, type SkillPackageFile } from "../skills/package.js";
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

/** A component version written by an upload ({@link PlatformComponents.uploadSkillVersion}). */
export interface UploadedComponentVersion {
  kind: "skill" | "agent_template";
  id: string;
  name: string;
  /** The version written (`current_version` after the upload). */
  version: number;
}

/** Who uploads (the super admin; `actorTokenId` when through a personal access token). */
export interface UploadActor {
  accountId: string;
  actorTokenId?: string;
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
   * A platform skill updated on its own (spec §7.2): the super admin uploads a skill package (zip)
   * for component `id`. The package keeps the component's name (else 400 `validation_failed`);
   * the new version keeps the component's plugin provenance and format, is flagged `updated_on_own`
   * (the next plugin update preview marks it) and serves in orgs at once (resolution is
   * read-time). Files go to the platform prefix before the transaction; a concurrent change of the
   * component -> 409 `component.version_stale`. Audits `component.version_uploaded`.
   */
  async uploadSkillVersion(
    actor: UploadActor,
    id: string,
    zip: Uint8Array,
  ): Promise<UploadedComponentVersion> {
    const pkg = await readSkillPackage(zip);
    this.files.assertAvailable();
    const live = await this.liveSkill(id);
    if (pkg.name !== live.name) throw nameChanged("skill", live.name, pkg.name);
    const to = live.current_version + 1;
    const prefix = platformSkillPrefix(id, to);
    await putCatalogFiles(this.files, prefix, pkg.files);
    await this.writeSkillVersionIn(actor, live, to, prefix, pkg);
    return { kind: "skill", id, name: live.name, version: to };
  }

  /**
   * A platform agent template updated on its own (spec §7.2), as {@link uploadSkillVersion}: the
   * template file (markdown) keeps the component's name.
   */
  async uploadAgentTemplateVersion(
    actor: UploadActor,
    id: string,
    text: string,
  ): Promise<UploadedComponentVersion> {
    const parsed = parseAgentTemplate(text);
    if ("errors" in parsed) {
      throw new ApiError(
        "validation_failed",
        `Invalid agent template: ${parsed.errors[0] ?? "unknown problem"}`,
        parsed.errors.map((message) => ({ path: "content", message })),
      );
    }
    this.files.assertAvailable();
    const live = await this.liveTemplate(id);
    if (parsed.template.name !== live.name) {
      throw nameChanged("agent template", live.name, parsed.template.name);
    }
    const to = live.current_version + 1;
    const prefix = platformAgentTemplatePrefix(id, to);
    const data = new TextEncoder().encode(text);
    const file: SkillPackageFile = {
      path: `${live.name}.md`,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      data,
    };
    await putCatalogFiles(this.files, prefix, [file]);
    await this.writeTemplateVersionIn(actor, live, to, prefix, parsed.template);
    return { kind: "agent_template", id, name: live.name, version: to };
  }

  private async liveSkill(id: string) {
    const live = await this.db
      .selectFrom("platform_skills")
      .select(["id", "name", "plugin_name", "current_version"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) throw new ApiError("component.not_found", `Platform skill ${id} not found`);
    return live;
  }

  private async liveTemplate(id: string) {
    const live = await this.db
      .selectFrom("platform_agent_templates")
      .select(["id", "name", "plugin_name", "current_version"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) throw new ApiError("component.not_found", `Platform agent template ${id} not found`);
    return live;
  }

  @Transactional()
  private async writeSkillVersionIn(
    actor: UploadActor,
    live: { id: string; name: string; plugin_name: string | null; current_version: number },
    to: number,
    prefix: string,
    pkg: Parameters<typeof skillManifest>[0],
  ): Promise<void> {
    // the lock of the plugin update and the import confirm: an update and an upload never interleave
    if (live.plugin_name !== null) await this.itemLock.lock(live.plugin_name);
    const t = this.db;
    const row = await t
      .selectFrom("platform_skills")
      .select(["current_version"])
      .where("id", "=", live.id)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (row?.current_version !== live.current_version) throw versionStale();
    const cur = await t
      .selectFrom("platform_skill_versions")
      .select(["source_format", "suggest_pinned"])
      .where("skill_id", "=", live.id)
      .where("version", "=", live.current_version)
      .executeTakeFirstOrThrow();
    const manifest = skillManifest(pkg);
    await t
      .updateTable("platform_skills")
      .set({ current_version: to, description: manifest.description, updated_at: new Date() })
      .where("id", "=", live.id)
      .execute();
    await t
      .insertInto("platform_skill_versions")
      .values({
        skill_id: live.id,
        version: to,
        manifest: JSON.stringify(manifest),
        object_prefix: prefix,
        catalog_version: null,
        source_format: cur.source_format,
        suggest_pinned: cur.suggest_pinned,
        updated_on_own: true,
        created_by: actor.accountId,
      })
      .execute();
    await audit(t, {
      actorAccountId: actor.accountId,
      ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
      action: "component.version_uploaded",
      target: live.id,
      detail: {
        kind: "skill",
        name: live.name,
        plugin: live.plugin_name,
        from: live.current_version,
        to,
      },
    });
  }

  @Transactional()
  private async writeTemplateVersionIn(
    actor: UploadActor,
    live: { id: string; name: string; plugin_name: string | null; current_version: number },
    to: number,
    prefix: string,
    template: AgentTemplate,
  ): Promise<void> {
    if (live.plugin_name !== null) await this.itemLock.lock(live.plugin_name);
    const t = this.db;
    const row = await t
      .selectFrom("platform_agent_templates")
      .select(["current_version"])
      .where("id", "=", live.id)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (row?.current_version !== live.current_version) throw versionStale();
    const cur = await t
      .selectFrom("platform_agent_template_versions")
      .select(["source_format", "suggest_pinned"])
      .where("template_id", "=", live.id)
      .where("version", "=", live.current_version)
      .executeTakeFirstOrThrow();
    await t
      .updateTable("platform_agent_templates")
      .set({ current_version: to, description: template.description, updated_at: new Date() })
      .where("id", "=", live.id)
      .execute();
    await t
      .insertInto("platform_agent_template_versions")
      .values({
        template_id: live.id,
        version: to,
        definition: JSON.stringify(template),
        object_prefix: prefix,
        catalog_version: null,
        source_format: cur.source_format,
        suggest_pinned: cur.suggest_pinned,
        updated_on_own: true,
        created_by: actor.accountId,
      })
      .execute();
    await audit(t, {
      actorAccountId: actor.accountId,
      ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
      action: "component.version_uploaded",
      target: live.id,
      detail: {
        kind: "agent_template",
        name: live.name,
        plugin: live.plugin_name,
        from: live.current_version,
        to,
      },
    });
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
    // New component rows carry the plugin's owner and 可共享 flag (ruling P3-2); an org plugin's
    // skills and agent templates were created in its owner org (`origin_org_id`, immutable, F27),
    // and like the plugin they are not shown to other orgs until the super admin shows them
    const item = await t
      .selectFrom("catalog_items")
      .select(["owner_org_id", "shareable"])
      .where("id", "=", plan.itemId)
      .executeTakeFirst();
    const ownerOrgId = item?.owner_org_id ?? null;
    const owned =
      ownerOrgId === null
        ? {}
        : { owner_org_id: ownerOrgId, shareable: item?.shareable === true, shown_to_others: false };
    const origin = ownerOrgId === null ? {} : { origin_org_id: ownerOrgId };

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
            ...owned,
            ...origin,
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
            ...owned,
            ...origin,
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
            ...owned,
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

const nameChanged = (what: string, was: string, now: string): ApiError =>
  new ApiError(
    "validation_failed",
    `An uploaded ${what} keeps the component's name: it is "${was}", the upload names "${now}"`,
    [{ path: "name", message: `must stay "${was}"` }],
  );

const versionStale = (): ApiError =>
  new ApiError("component.version_stale", "The component changed meanwhile; upload it again");
