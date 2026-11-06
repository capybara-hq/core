// Promote on share (plugin scope phase 3, spec §14, rulings P3-3 to P3-6, P3-23): an org's own
// skill or agent template stays an org row (`skills` / `agent_templates`) until the super admin
// first shows it to other orgs or associates it with one. That action promotes it, in its own
// transaction: a platform row owned by the org (`owner_org_id` = `origin_org_id` = the org,
// `scope_mode own`, `named: [owner]`, `shown_to_others false`) at the org row's version number,
// and the org row linked to it without a pin (ruling B2). The owner's agents keep referencing the
// org row's id; `skills/usable.ts` and `agents/templates.ts` serve that row its own stored version
// while it is the platform row's current one, so nothing the owner's agents see changes (no
// "Updated skills" line, same `subagent_started` reference). Other orgs reference the platform id.
import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb, SkillManifest } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { StorageService } from "../storage/storage.service.js";
import { putCatalogFiles } from "./catalog-items.js";
import { platformSkillPrefix, uniqueVersionPrefix } from "./platform-components.js";

/** The kinds an org owns as rows of its own (connector templates have none). */
export type PromotableKind = "skill" | "agent_template";

/**
 * An org's own skill (org scope) or agent template, as the admin component routes see it: not
 * linked (`link` null), or linked to a platform row the same org owns (`link`: that row, already
 * promoted). A copy linked to a platform row of another owner is never an `OrgRow`.
 */
export interface OrgRow {
  kind: PromotableKind;
  id: string;
  orgId: string;
  name: string;
  /** The roster plugin of an agent template (null: a bare `<name>`); null for skills. */
  plugin: string | null;
  version: number;
  shareable: boolean;
  /** The platform row the org promoted it to, or null while it is an org row only. */
  link: string | null;
  /**
   * Content the org created itself (ruling P3-46): a skill without plugin provenance
   * (`catalog_item_id` null); an agent template without a plugin and a catalog item (an org
   * template saved from an agent, ruling P4-13). Anything else is refused with 409
   * `catalog.not_owned`.
   */
  ownable: boolean;
}

/** A promotion whose files are copied ({@link ComponentPromotion.prepare}), waiting for its rows. */
export interface PreparedPromotion {
  readonly kind: PromotableKind;
  readonly orgRowId: string;
  readonly orgId: string;
  /** The platform id it gets (the existing one when the row is promoted already). */
  readonly platformId: string;
  /** The org row's version the files were copied from. */
  readonly version: number;
  readonly already: boolean;
  /** Where the files were copied (a fresh prefix, ruling P3-45); null: nothing copied. */
  readonly prefix: string | null;
}

/** The org row changed between {@link ComponentPromotion.prepare} and its transaction: prepare again. */
export class PromotionStale extends Error {}

/** How many times a caller prepares again after {@link PromotionStale}. */
export const PROMOTION_ATTEMPTS = 3;

const notFound = () => new ApiError("component.not_found", "Component not found");

/** 409 `catalog.not_owned`: only the org's own rows can be shared (P3-6). */
export function notOwnedError(what: string): ApiError {
  return new ApiError(
    "catalog.not_owned",
    `${what} is not this organization's own: only its own org skills and agent templates can be shared`,
  );
}

/** 409 `component.version_stale`: the org row kept changing while it was being promoted. */
export const promotionStaleError = (): ApiError =>
  new ApiError(
    "component.version_stale",
    "The skill or agent template changed while it was being shared; try again",
  );

/** The platform table of a kind. */
const PLATFORM_TABLE = {
  skill: "platform_skills",
  agent_template: "platform_agent_templates",
} as const;

/**
 * Promotes an org's own skill or agent template to a platform row when it is first shared
 * (ruling P3-3). Stateless, shared by every replica.
 */
@Injectable()
export class ComponentPromotion {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    /** Where files are read and written (the kernel's object storage). */
    @Inject(StorageService) private readonly files: StorageService,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * The live org row `id` of `kind` (an org-scope skill, an agent template) of a live org, when it
   * is the org's own (see {@link OrgRow}); undefined otherwise.
   */
  async orgRow(kind: PromotableKind, id: string, forUpdate = false): Promise<OrgRow | undefined> {
    return readOrgRow(this.db, kind, id, forUpdate);
  }

  /**
   * The first phase, outside any transaction: reads the org row and (a skill) copies its current
   * version's files to `deployment/platform/skills/<platformId>/<version>/`, checking each file
   * against the manifest. A row promoted already needs nothing. A failed copy throws and nothing is
   * linked (the copied files stay unreferenced). Missing or not the org's own -> 404.
   */
  async prepare(kind: PromotableKind, orgRowId: string): Promise<PreparedPromotion> {
    const row = await this.orgRow(kind, orgRowId);
    if (!row) throw notFound();
    if (row.link !== null) {
      return {
        kind,
        orgRowId,
        orgId: row.orgId,
        platformId: row.link,
        version: row.version,
        already: true,
        prefix: null,
      };
    }
    if (!row.ownable) throw notOwnedError(row.name);
    const platformId = randomUUID();
    const prefix =
      kind === "skill" ? uniqueVersionPrefix(platformSkillPrefix(platformId, row.version)) : null;
    if (prefix !== null) await this.copySkillFiles(row, prefix);
    return {
      kind,
      orgRowId,
      orgId: row.orgId,
      platformId,
      version: row.version,
      already: false,
      prefix,
    };
  }

  /** Deletes a prepared promotion's files after its transaction failed (best effort, P3-45). */
  async discard(p: PreparedPromotion): Promise<void> {
    if (p.prefix === null) return;
    try {
      await this.files.deployment().deletePrefix(p.prefix);
    } catch {
      // unreferenced objects only: nothing reads them
    }
  }

  /**
   * The second phase, in the caller's transaction: re-reads the org row under its lock (after the
   * org row, so an org deletion is serialized), checks the share gate on it (409
   * `catalog.not_shareable`) and writes the platform row (`current_version` = the org row's, one
   * version row at that number), its list `[owner]`, and the link (no pin). Idempotent: a row the
   * org promoted already returns its platform id. A version written since {@link prepare} ->
   * {@link PromotionStale}; a live platform row of the same name created in this org already (a
   * shared item whose owner deleted it and then made a new one) -> 409 `plugin.skill_conflict`.
   * Audits `component.promoted`. Returns the platform id.
   */
  @Transactional({ propagation: "mandatory" })
  async promote(p: PreparedPromotion, actor: string | null): Promise<string> {
    const org = await this.db
      .selectFrom("orgs")
      .select("id")
      .where("id", "=", p.orgId)
      .where("deleted_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!org) throw notFound();
    const row = await this.orgRow(p.kind, p.orgRowId, true);
    if (!row) throw notFound();
    if (row.link !== null) return row.link;
    if (!row.ownable) throw notOwnedError(row.name);
    if (!row.shareable) {
      throw new ApiError(
        "catalog.not_shareable",
        `${row.name} is owned by an organization that has not made it shareable`,
      );
    }
    if (p.already || p.version !== row.version) throw new PromotionStale();
    const table = PLATFORM_TABLE[p.kind];
    const taken = await this.db
      .selectFrom(table as "platform_skills")
      .select("id")
      .where("name", "=", row.name)
      .where("origin_org_id", "=", row.orgId)
      .where(sql<string>`coalesce(plugin_name, '')`, "=", row.plugin ?? "")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (taken) {
      throw new ApiError(
        "plugin.skill_conflict",
        `A shared ${p.kind === "skill" ? "skill" : "agent template"} named "${row.name}" from this organization already exists on the platform`,
        [{ skill: row.name, orgId: row.orgId, skills: [taken.id], source: { kind: "org" } }],
      );
    }
    const owned = {
      owner_org_id: row.orgId,
      origin_org_id: row.orgId,
      shareable: row.shareable,
      shown_to_others: false,
      scope_mode: "own" as const,
      scope: "named" as const,
    };
    if (p.kind === "skill") {
      const v = await this.db
        .selectFrom("skill_versions")
        .select(["manifest", "source_format", "suggest_pinned", "created_by"])
        .where("skill_id", "=", row.id)
        .where("version", "=", row.version)
        .executeTakeFirstOrThrow();
      await this.db
        .insertInto("platform_skills")
        .values({
          id: p.platformId,
          catalog_item_id: null,
          plugin_name: null,
          name: row.name,
          description: v.manifest.description,
          description_zh: null,
          current_version: row.version,
          ...owned,
        })
        .execute();
      await this.db
        .insertInto("platform_skill_versions")
        .values({
          skill_id: p.platformId,
          version: row.version,
          manifest: JSON.stringify(v.manifest),
          object_prefix: p.prefix as string,
          catalog_version: null,
          source_format: v.source_format,
          suggest_pinned: v.suggest_pinned,
          created_by: v.created_by,
        })
        .execute();
      await this.db
        .updateTable("skills")
        .set({ platform_skill_id: p.platformId, updated_at: sql`now()` })
        .where("id", "=", row.id)
        .execute();
    } else {
      const v = await this.db
        .selectFrom("agent_template_versions")
        .select(["definition", "source_format", "catalog_version"])
        .where("template_id", "=", row.id)
        .where("version", "=", row.version)
        .executeTakeFirstOrThrow();
      const description = (v.definition as { description?: unknown } | null)?.description;
      await this.db
        .insertInto("platform_agent_templates")
        .values({
          id: p.platformId,
          catalog_item_id: null,
          // the roster type `<plugin>:<name>` is model-visible: other orgs see the same type
          plugin_name: row.plugin,
          name: row.name,
          description: typeof description === "string" ? description : null,
          current_version: row.version,
          ...owned,
        })
        .execute();
      await this.db
        .insertInto("platform_agent_template_versions")
        .values({
          template_id: p.platformId,
          version: row.version,
          // the stored definition as it is (its tool keys are normalized when read)
          definition: JSON.stringify(v.definition),
          // an org template has no file: only its parsed definition is stored
          object_prefix: null,
          catalog_version: v.catalog_version,
          source_format: v.source_format,
        })
        .execute();
      await this.db
        .updateTable("agent_templates")
        .set({ platform_template_id: p.platformId, updated_at: new Date() })
        .where("id", "=", row.id)
        .execute();
    }
    await this.db
      .insertInto("component_scope_orgs")
      .values({ kind: p.kind, component_id: p.platformId, org_id: row.orgId })
      .execute();
    await audit(this.db, {
      actorAccountId: actor,
      orgId: row.orgId,
      action: "component.promoted",
      target: p.platformId,
      detail: { kind: p.kind, name: row.name, from: row.id, version: row.version },
    });
    return p.platformId;
  }

  /** Copies the skill's current version files to its platform prefix (outside any transaction). */
  private async copySkillFiles(row: OrgRow, prefix: string): Promise<void> {
    const v = await this.db
      .selectFrom("skill_versions")
      .select(["manifest", "object_prefix"])
      .where("skill_id", "=", row.id)
      .where("version", "=", row.version)
      .executeTakeFirst();
    if (!v) throw notFound();
    this.files.assertAvailable();
    const store = this.files.kernel(row.orgId);
    const out: { path: string; size: number; data: Uint8Array }[] = [];
    for (const f of (v.manifest as SkillManifest).files) {
      const got = await store.get(`${v.object_prefix}${f.path}`);
      if (!got) throw new ApiError("internal", `Stored skill file ${f.path} is missing`);
      const data = new Uint8Array(await new Response(got.body).arrayBuffer());
      if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
        throw new ApiError("internal", `Stored skill file ${f.path} does not match its manifest`);
      }
      out.push({ path: f.path, size: data.byteLength, data });
    }
    await putCatalogFiles(this.files, prefix, out);
  }
}

/** {@link ComponentPromotion.orgRow} through `db` (readers outside the provider). */
export async function readOrgRow(
  db: KernelSchemaDb,
  kind: PromotableKind,
  id: string,
  forUpdate = false,
): Promise<OrgRow | undefined> {
  if (kind === "skill") {
    let q = db
      .selectFrom("skills as s")
      .innerJoin("orgs as o", "o.id", "s.org_id")
      .leftJoin("platform_skills as p", "p.id", "s.platform_skill_id")
      .select([
        "s.id",
        "s.org_id",
        "s.name",
        "s.current_version",
        "s.shareable",
        "s.platform_skill_id",
        "s.pinned_version",
        "s.catalog_item_id",
        "p.owner_org_id",
        "p.deleted_at as p_deleted_at",
      ])
      .where("s.id", "=", id)
      .where("s.scope", "=", "org")
      .where("s.deleted_at", "is", null)
      .where("o.deleted_at", "is", null);
    if (forUpdate) q = q.forUpdate("s");
    const r = await q.executeTakeFirst();
    if (!r) return undefined;
    const link = ownedLink(r);
    if (link === false) return undefined;
    return {
      kind,
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      plugin: null,
      version: r.current_version,
      shareable: r.shareable,
      link,
      ownable: r.catalog_item_id === null,
    };
  }
  let q = db
    .selectFrom("agent_templates as t")
    .innerJoin("orgs as o", "o.id", "t.org_id")
    .leftJoin("platform_agent_templates as p", "p.id", "t.platform_template_id")
    .select([
      "t.id",
      "t.org_id",
      "t.name",
      "t.plugin_name",
      "t.current_version",
      "t.shareable",
      "t.platform_template_id as platform_skill_id",
      "t.pinned_version",
      "t.catalog_item_id",
      "p.owner_org_id",
      "p.deleted_at as p_deleted_at",
    ])
    .where("t.id", "=", id)
    .where("t.deleted_at", "is", null)
    .where("o.deleted_at", "is", null);
  if (forUpdate) q = q.forUpdate("t");
  const r = await q.executeTakeFirst();
  if (!r) return undefined;
  const link = ownedLink(r);
  if (link === false) return undefined;
  return {
    kind,
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    plugin: r.plugin_name,
    version: r.current_version,
    shareable: r.shareable,
    link,
    // an org template (ruling P4-13); a plugin's template keeps its roster type and is not
    ownable: r.catalog_item_id === null && r.plugin_name === null,
  };
}

/**
 * The platform row an org row is promoted to (null: not linked), or false when the row is a copy
 * of a platform row the org does not own (P3-6: not the org's own).
 */
function ownedLink(r: {
  org_id: string;
  platform_skill_id: string | null;
  pinned_version: number | null;
  owner_org_id: string | null;
  p_deleted_at: Date | null;
}): string | null | false {
  if (r.platform_skill_id === null) return null;
  if (r.pinned_version === null && r.owner_org_id === r.org_id && r.p_deleted_at === null) {
    return r.platform_skill_id;
  }
  return false;
}
