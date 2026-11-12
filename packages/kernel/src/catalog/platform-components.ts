// Platform components (plugin scope phase 2, rulings A2 and C2): the skills, agent templates,
// connector templates and themes of a catalog item, stored once for the deployment. Files live
// under `deployment/platform/{skills,agent-templates,themes}/…/`, never under an org prefix (orgs
// are purged by prefix): a plugin sync's under the digest of their content
// (`sha256-<digest>/`, {@link contentPrefix}), an upload's or a promotion's under
// `<id>/<version>-<uuid>/`.
import { createHash, randomUUID } from "node:crypto";
import {
  type AgentTemplate,
  type ConnectorTemplateFile,
  type ParsedTheme,
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
import { readSkillPackage, type SkillPackageFile, skillManifest } from "../skills/package.js";
import { type PrefixedStorage, StorageService } from "../storage/storage.service.js";
import { canonicalJson } from "../tools/canonical-json.js";
import {
  type CatalogVersionFiles,
  readCatalogAgentTemplates,
  readCatalogFiles,
  readCatalogTemplates,
  readCatalogThemes,
  skillFilesDigest,
  skillOf,
  themeAssetsDigest,
} from "./catalog-content.js";
import { putCatalogFiles } from "./catalog-items.js";
import { CatalogItemLock } from "./locks.js";
import { assertNotAwaiting } from "./ownership.js";

/** A skill, agent template or theme version a sync wrote (`from` null: the component was created). */
export interface ChangedRef {
  kind: "skill" | "agent_template" | "theme";
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
  themes: ChangedRef[];
}

/** The prefix (in `deployment/`) of a platform skill version's files. */
export const platformSkillPrefix = (id: string, version: number): string =>
  `platform/skills/${id}/${version}/`;

/** The prefix (in `deployment/`) of a platform agent template version's file. */
export const platformAgentTemplatePrefix = (id: string, version: number): string =>
  `platform/agent-templates/${id}/${version}/`;

/**
 * A fresh prefix (in `deployment/`) for a version written before its transaction (ruling P3-45):
 * `<id>/<version>-<uuid>/`, so two writers racing for one version number never overwrite each
 * other's objects, and the loser's are deleted after its transaction failed.
 */
export const uniqueVersionPrefix = (base: string): string =>
  `${base.slice(0, -1)}-${randomUUID()}/`;

/**
 * The prefix (in `deployment/`) of the files a plugin sync writes for a component version:
 * `platform/<kind>/sha256-<digest>/`, the digest of the files' paths and contents
 * ({@link skillFilesDigest}). The files are copied before the transaction that writes the rows (no
 * storage call holds a row lock), so the same content always lands on the same keys: a sync or an
 * import that is retried after its transaction rolled back writes nothing new, and versions with
 * the same content share their objects. Objects are immutable and nothing deletes them (versions
 * are kept), so an import that rolled back leaves at most objects a later import of that content
 * reuses. Stored on the version row; readers use the stored prefix, so rows written before keep
 * theirs.
 */
export const contentPrefix = (
  kind: "skills" | "agent-templates" | "themes",
  files: { path: string; sha256: string }[],
): string => `platform/${kind}/sha256-${skillFilesDigest(files)}/`;

/** 409 `catalog.not_owned`: an org's own promoted item is versioned by its owner only (P3-48). */
const ownedByOrg = (what: string, name: string): ApiError =>
  new ApiError(
    "catalog.not_owned",
    `The ${what} ${name} belongs to an organization that shared it: only that organization uploads its versions`,
  );

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

interface ThemeStep {
  /** The theme id. */
  name: string;
  base: Base<number> | undefined;
  /** The platform row id. */
  id: string;
  to: number;
  /** null: the theme has no assets. */
  prefix: string | null;
  /** Fonts and logo, sanitized (paths relative to the plugin root). */
  files: SkillPackageFile[];
  theme: ParsedTheme;
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
  themes: ThemeStep[];
}

/** A component changed between the plan and its write (a concurrent sync): plan again. */
export class PlanStale extends Error {}

/**
 * A sync planned and its files copied ({@link PlatformComponents.prepareSync},
 * {@link PlatformComponents.prepareImport}), waiting for its rows
 * ({@link PlatformComponents.applySyncIn}). Opaque outside this module but for the item and the
 * catalog version it was planned for.
 */
export interface PreparedSync {
  readonly plan: SyncPlan;
}

/**
 * The catalog version a sync plans from: its row, or a staged import whose row its transaction
 * is about to write (the files are in object storage under `objectPrefix` already).
 */
export interface SyncSource {
  itemId: string;
  /** The plugin (the catalog item's name). */
  plugin: string;
  version: string;
  manifest: PluginManifest;
  objectPrefix: string | null;
  files: { path: string; size: number; sha256: string }[];
  sourceFormat: SourceFormat;
}

/** A component version written by an upload ({@link PlatformComponents.uploadSkillVersion}). */
export interface UploadedComponentVersion {
  kind: "skill" | "agent_template";
  id: string;
  name: string;
  /** The version written (`current_version` after the upload). */
  version: number;
}

/**
 * The owner's next version of a skill it promoted (ruling P3-4), its files written
 * ({@link PlatformComponents.prepareOwnerVersion}), waiting for its row
 * ({@link PlatformComponents.addOwnerVersionIn}).
 */
export interface OwnerVersion {
  readonly platformId: string;
  /** The version it becomes (the platform row's current version + 1 when prepared). */
  readonly to: number;
  readonly prefix: string;
}

/** Who uploads (the super admin; `actorTokenId` when through a personal access token). */
export interface UploadActor {
  accountId: string;
  actorTokenId?: string;
  /** Added to the audit detail (the Platform tool's `via`). */
  auditDetail?: Record<string, unknown>;
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
   * Files are copied from the catalog prefix to `deployment/platform/…` (keyed by content,
   * {@link contentPrefix}) before the rows are written in a transaction of their own, so a sync
   * that stops midway leaves at most files a retry reuses, and running it again is a no-op once it
   * succeeded. `initial` is logged. Components missing from the version are left alone (the
   * platform update decides what a removal means). On success the item records `version` as
   * `platform_synced_version`. The import and the platform update write the rows in their own
   * transaction instead ({@link prepareImport} / {@link prepareSync}, then {@link applySyncIn}).
   */
  async syncFromVersion(
    itemId: string,
    version: string,
    opts: { initial: boolean },
  ): Promise<PlatformSyncResult> {
    for (let attempt = 1; ; attempt++) {
      const plan = await this.planFrom(await this.source(itemId, version, false));
      if (
        plan.skills.length === 0 &&
        plan.agentTemplates.length === 0 &&
        plan.connectorTemplates.length === 0 &&
        plan.themes.length === 0
      ) {
        await this.markSynced(itemId, version);
        return { skills: [], agentTemplates: [], connectorTemplates: [], themes: [] };
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
          themes: r.themes.length,
        });
        return r;
      } catch (e) {
        if (!(e instanceof PlanStale) || attempt >= SYNC_ATTEMPTS) throw e;
      }
    }
  }

  /**
   * The first phase of a sync inside a caller's transaction (the platform plugin update, the super
   * admin's confirmation of an org upload's first version: `confirming`, the item still awaiting
   * it): plans the version's components and copies their files, outside any transaction (no
   * storage call holds a row lock). {@link applySyncIn} writes the rows.
   */
  async prepareSync(
    itemId: string,
    version: string,
    opts: { confirming?: boolean } = {},
  ): Promise<PreparedSync> {
    const plan = await this.planFrom(await this.source(itemId, version, opts.confirming === true));
    await this.writeFiles(plan);
    return { plan };
  }

  /**
   * {@link prepareSync} for an import whose transaction writes the catalog version (the item may
   * not exist yet): plans from the staged content and copies the files, before that transaction.
   */
  async prepareImport(source: SyncSource): Promise<PreparedSync> {
    const plan = await this.planFrom(source);
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
    if (live.promoted) throw ownedByOrg("skill", live.name);
    if (pkg.name !== live.name) throw nameChanged("skill", live.name, pkg.name);
    const to = live.current_version + 1;
    const prefix = uniqueVersionPrefix(platformSkillPrefix(id, to));
    await putCatalogFiles(this.files, prefix, pkg.files);
    try {
      await this.writeSkillVersionIn(actor, live, to, prefix, pkg);
    } catch (e) {
      await this.discardPrefix(prefix);
      throw e;
    }
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
    if (live.promoted) throw ownedByOrg("agent template", live.name);
    if (parsed.template.name !== live.name) {
      throw nameChanged("agent template", live.name, parsed.template.name);
    }
    const to = live.current_version + 1;
    const prefix = uniqueVersionPrefix(platformAgentTemplatePrefix(id, to));
    const data = new TextEncoder().encode(text);
    const file: SkillPackageFile = {
      path: `${live.name}.md`,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      data,
    };
    await putCatalogFiles(this.files, prefix, [file]);
    try {
      await this.writeTemplateVersionIn(actor, live, to, prefix, parsed.template);
    } catch (e) {
      await this.discardPrefix(prefix);
      throw e;
    }
    return { kind: "agent_template", id, name: live.name, version: to };
  }

  /**
   * The first phase of the owner's new version of platform skill `platformId` (ruling P3-4: an org
   * that promoted its skill writes later versions to the platform row, never a pin on its copy):
   * the files go to a fresh `deployment/platform/skills/<id>/<current + 1>-<uuid>/` (ruling
   * P3-45), outside any transaction; a caller whose transaction then fails calls
   * {@link discardPrefix}. Missing -> 404 `component.not_found`.
   */
  async prepareOwnerVersion(platformId: string, files: SkillPackageFile[]): Promise<OwnerVersion> {
    this.files.assertAvailable();
    const live = await this.liveSkill(platformId);
    const to = live.current_version + 1;
    const prefix = uniqueVersionPrefix(platformSkillPrefix(platformId, to));
    await putCatalogFiles(this.files, prefix, files);
    return { platformId, to, prefix };
  }

  /**
   * The second phase, in the caller's transaction (the owner org's skill upload, under the org row
   * and the copy's row lock): the platform row becomes version `v.to` with `manifest`, keeping its
   * format. A version written since the first phase -> 409 `component.version_stale`. Returns
   * the version written. The caller tells the orgs using it (`notifySharedUpdate`).
   */
  @Transactional({ propagation: "mandatory" })
  async addOwnerVersionIn(
    v: OwnerVersion,
    manifest: SkillManifest,
    actorAccountId: string | null,
  ): Promise<number> {
    const t = this.db;
    const row = await t
      .selectFrom("platform_skills")
      .select(["current_version"])
      .where("id", "=", v.platformId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (row?.current_version !== v.to - 1) throw versionStale();
    const cur = await t
      .selectFrom("platform_skill_versions")
      .select(["source_format"])
      .where("skill_id", "=", v.platformId)
      .where("version", "=", row.current_version)
      .executeTakeFirstOrThrow();
    await t
      .updateTable("platform_skills")
      .set({ current_version: v.to, description: manifest.description, updated_at: new Date() })
      .where("id", "=", v.platformId)
      .execute();
    await t
      .insertInto("platform_skill_versions")
      .values({
        skill_id: v.platformId,
        version: v.to,
        manifest: JSON.stringify(manifest),
        object_prefix: v.prefix,
        catalog_version: null,
        source_format: cur.source_format,
        created_by: actorAccountId,
      })
      .execute();
    return v.to;
  }

  /**
   * Deletes the objects a version wrote before its transaction failed (ruling P3-45), best effort:
   * nothing references them; a failure is logged.
   */
  async discardPrefix(prefix: string): Promise<void> {
    try {
      await this.files.deployment().deletePrefix(prefix);
    } catch (err) {
      this.log.warn("deleting an unused platform version's files failed", { prefix, err });
    }
  }

  private async liveSkill(id: string) {
    const live = await this.db
      .selectFrom("platform_skills")
      .select(["id", "name", "plugin_name", "current_version", "owner_org_id", "catalog_item_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) throw new ApiError("component.not_found", `Platform skill ${id} not found`);
    return { ...live, promoted: isPromoted(live) };
  }

  private async liveTemplate(id: string) {
    const live = await this.db
      .selectFrom("platform_agent_templates")
      .select(["id", "name", "plugin_name", "current_version", "owner_org_id", "catalog_item_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) throw new ApiError("component.not_found", `Platform agent template ${id} not found`);
    return { ...live, promoted: isPromoted(live) };
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
      .select(["current_version", "owner_org_id", "catalog_item_id"])
      .where("id", "=", live.id)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (row?.current_version !== live.current_version) throw versionStale();
    if (isPromoted(row)) throw ownedByOrg("skill", live.name);
    const cur = await t
      .selectFrom("platform_skill_versions")
      .select(["source_format"])
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
        ...actor.auditDetail,
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
      .select(["current_version", "owner_org_id", "catalog_item_id"])
      .where("id", "=", live.id)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (row?.current_version !== live.current_version) throw versionStale();
    if (isPromoted(row)) throw ownedByOrg("agent template", live.name);
    const cur = await t
      .selectFrom("platform_agent_template_versions")
      .select(["source_format"])
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
        ...actor.auditDetail,
      },
    });
  }

  /**
   * Records that the item's platform components are written from `version`
   * (`catalog_items.platform_synced_version`, the version orgs install).
   */
  private async markSynced(itemId: string, version: string): Promise<void> {
    await this.db
      .updateTable("catalog_items")
      .set({ platform_synced_version: version })
      .where("id", "=", itemId)
      .execute();
  }

  /**
   * The stored catalog version `version` of live item `itemId`. An org upload still waiting for the
   * super admin has no platform components (P3-9) unless this is its `confirming`.
   */
  private async source(itemId: string, version: string, confirming: boolean): Promise<SyncSource> {
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["name", "awaiting_confirmation"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (item !== undefined && !confirming) assertNotAwaiting(item);
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
    return {
      itemId,
      plugin: item.name,
      version,
      manifest: row.manifest as PluginManifest,
      objectPrefix: row.object_prefix,
      files: row.files,
      sourceFormat: row.source_format,
    };
  }

  /** Reads the version's components and the live platform rows; keeps only what changed. */
  private async planFrom(src: SyncSource): Promise<SyncPlan> {
    const { itemId, plugin, version, manifest } = src;
    const v: CatalogVersionFiles = {
      manifest,
      object_prefix: src.objectPrefix,
      files: src.files,
    };
    const plan: SyncPlan = {
      itemId,
      plugin,
      version,
      sourceFormat: src.sourceFormat,
      skills: [],
      agentTemplates: [],
      connectorTemplates: [],
      themes: [],
    };

    for (const s of manifest.skills ?? []) {
      const files = await readCatalogFiles(
        this.files,
        v.object_prefix,
        v.files,
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
        prefix: contentPrefix("skills", files),
        files,
        manifest: skillManifest(pkg),
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
        // never an org's own template it promoted under the same roster type (ruling P3-3)
        .where((eb) =>
          eb.or([eb("p.catalog_item_id", "is not", null), eb("p.origin_org_id", "is", null)]),
        )
        .executeTakeFirst();
      if (live && canonicalJson(live.definition) === canonicalJson(a.template)) continue;
      const [file] = await readCatalogFiles(
        this.files,
        v.object_prefix,
        v.files.filter((f) => f.path === a.path),
      );
      if (!file) throw new ApiError("internal", `Stored agent template ${a.path} is missing`);
      const id = live?.id ?? randomUUID();
      const to = (live?.current_version ?? 0) + 1;
      const name = file.path.split("/").pop() as string;
      plan.agentTemplates.push({
        name: a.template.name,
        base: live && { id: live.id, version: live.current_version },
        id,
        to,
        prefix: contentPrefix("agent-templates", [{ path: name, sha256: file.sha256 }]),
        file: { ...file, path: name },
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

    // Themes (by plugin and id): changed when the definition or an asset changed
    for (const t of await readCatalogThemes(this.files, v)) {
      const live = await this.db
        .selectFrom("platform_themes as p")
        .innerJoin("platform_theme_versions as pv", (j) =>
          j.onRef("pv.theme_id", "=", "p.id").onRef("pv.version", "=", "p.current_version"),
        )
        .leftJoin("catalog_item_versions as cv", (j) =>
          j
            .onRef("cv.item_id", "=", "p.catalog_item_id")
            .onRef("cv.version", "=", "pv.catalog_version"),
        )
        .select(["p.id", "p.current_version", "pv.definition", "cv.files"])
        .where("p.plugin_name", "=", plugin)
        .where("p.name", "=", t.id)
        .where("p.deleted_at", "is", null)
        .executeTakeFirst();
      if (
        live &&
        canonicalJson(live.definition) === canonicalJson(t.theme) &&
        live.files !== null &&
        themeAssetsDigest(live.files, live.definition) === t.assetsDigest
      ) {
        continue;
      }
      const id = live?.id ?? randomUUID();
      const to = (live?.current_version ?? 0) + 1;
      plan.themes.push({
        name: t.id,
        base: live && { id: live.id, version: live.current_version },
        id,
        to,
        prefix: t.assets.length > 0 ? contentPrefix("themes", t.assets) : null,
        files: t.assets,
        theme: t.theme,
      });
    }
    return plan;
  }

  /** Copies the planned versions' files to their platform prefixes. */
  private async writeFiles(plan: SyncPlan): Promise<void> {
    const themes = plan.themes.filter((t) => t.prefix !== null);
    if (plan.skills.length === 0 && plan.agentTemplates.length === 0 && themes.length === 0) return;
    this.files.assertAvailable();
    for (const s of plan.skills) await putCatalogFiles(this.files, s.prefix, s.files);
    for (const a of plan.agentTemplates) await putCatalogFiles(this.files, a.prefix, [a.file]);
    for (const t of themes) await putCatalogFiles(this.files, t.prefix as string, t.files);
  }

  /**
   * Writes the planned rows under the item name's lock (the lock of the import confirm), after
   * checking that every component is still where the plan found it ({@link PlanStale} otherwise).
   */
  @Transactional()
  private async apply(plan: SyncPlan): Promise<PlatformSyncResult> {
    await this.itemLock.lock(plan.plugin);
    const t = this.db;
    const out: PlatformSyncResult = {
      skills: [],
      agentTemplates: [],
      connectorTemplates: [],
      themes: [],
    };
    // New component rows carry the plugin's owner and 可共享 flag (ruling P3-2); an org plugin's
    // skills and agent templates were created in its owner org (`origin_org_id`, immutable, F27),
    // and like the plugin they are not shown to other orgs until the super admin shows them
    // Under the item row lock: an item removed since the plan (an org deletion, P3-20) gets no
    // component rows (the item before its components, ruling P3-50)
    const item = await t
      .selectFrom("catalog_items")
      .select(["owner_org_id", "shareable", "deleted_at"])
      .where("id", "=", plan.itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!item || item.deleted_at !== null) {
      throw new ApiError("catalog.item_not_found", `Catalog item ${plan.itemId} was removed`);
    }
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
        .where((eb) =>
          eb.or([eb("catalog_item_id", "is not", null), eb("origin_org_id", "is", null)]),
        )
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

    for (const th of plan.themes) {
      const live = await t
        .selectFrom("platform_themes")
        .select(["id", "current_version"])
        .where("plugin_name", "=", plan.plugin)
        .where("name", "=", th.name)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      assertBase(live && { id: live.id, version: live.current_version }, th.base);
      const description = th.theme.description?.en ?? null;
      const descriptionZh = th.theme.description?.zh ?? null;
      if (live) {
        await t
          .updateTable("platform_themes")
          .set({
            current_version: th.to,
            description,
            description_zh: descriptionZh,
            catalog_item_id: plan.itemId,
            updated_at: new Date(),
          })
          .where("id", "=", th.id)
          .execute();
      } else {
        await t
          .insertInto("platform_themes")
          .values({
            id: th.id,
            catalog_item_id: plan.itemId,
            plugin_name: plan.plugin,
            name: th.name,
            description,
            description_zh: descriptionZh,
            current_version: th.to,
            scope_mode: "follow",
            ...owned,
            ...origin,
          })
          .execute();
      }
      await t
        .insertInto("platform_theme_versions")
        .values({
          theme_id: th.id,
          version: th.to,
          definition: JSON.stringify(th.theme),
          object_prefix: th.prefix,
          catalog_version: plan.version,
        })
        .execute();
      out.themes.push({
        kind: "theme",
        id: th.id,
        name: th.name,
        from: th.base?.version ?? null,
        to: th.to,
      });
    }
    return out;
  }
}

/** An org's own item it promoted (ruling P3-3): owned by an org, from no plugin. */
const isPromoted = (r: { owner_org_id: string | null; catalog_item_id: string | null }): boolean =>
  r.owner_org_id !== null && r.catalog_item_id === null;

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
