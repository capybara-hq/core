// The owner org's own catalog items (plugin scope phase 3, spec §14, rulings P3-2, P3-17 to
// P3-20; pre-flight F13 to F16, F19): 可共享, delete after a preview, and the one rule an owner
// delete and an org deletion share: an item another org uses is transferred to the platform, any
// other one is removed (a plugin's extension then taken out by `OwnedPluginCleanup`). Plugins and,
// since Task 8, the org's own skills and agent templates (promoted ones through their platform
// rows, ruling P3-3).
import { createHash } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { addPlatformNotice } from "../inbox/platform-notices.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { SkillsService } from "../skills/skills.service.js";
import { type ActorOpts, CatalogService } from "./catalog.service.js";
import { CatalogScopeService } from "./catalog-scope.service.js";
import { notOwnedError } from "./component-promotion.js";
import {
  agentsUsing,
  COMPONENT_KINDS,
  type ComponentKind,
  type ComponentRow,
  componentOn,
  listedIn,
  loadComponents,
  loadScopeState,
  pluginFactsOf,
  switchOf,
} from "./component-state.js";
import { ownedPluginCleanupJob } from "./job-ids.js";
import { type OwnedRef, orgsUsing } from "./ownership.js";
import { PluginInstaller } from "./plugin-install.js";
import { ScopeStillWanted } from "./scope-state.js";
import { narrowComponentOnUnshare } from "./unshare.js";

/**
 * What deleting an owned plugin does (P3-19): `removed` when no other org uses it, else
 * `transferred` to the platform; `orgs` the other orgs using it (their names were disclosed by
 * `item_shared` notices already), `agents` the owner's agents that lose it. Confirmed with
 * `previewHash`.
 */
export interface OwnedDeletePreview {
  outcome: "removed" | "transferred";
  orgs: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  previewHash: string;
}

/** Why an owned item leaves its owner (the `ownership_transferred` notice's `reason`). */
export type OwnerLeaveReason = "owner_deleted" | "org_deleted";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const previewStale = () =>
  new ApiError(
    "catalog.preview_stale",
    "What deleting this plugin does has changed since the preview; preview it again and confirm the new hash",
  );
const skillNotFound = () => new ApiError("skill.not_found", "Skill not found");
const componentNotFound = () => new ApiError("component.not_found", "Component not found");

/** What deleting an org skill does (`GET orgs/:orgId/skills/:id/delete-preview`, pre-flight F19). */
export type OwnedSkillDeletePreview = Omit<OwnedDeletePreview, "previewHash">;

/** An org's own skill or agent template row, as its owner acts on it (ruling P3-6). */
interface OwnedComponentRow {
  id: string;
  name: string;
  /** The platform row it was promoted to (ruling P3-3), or null. */
  link: string | null;
}

const COMPONENT_TABLES = [
  "platform_skills",
  "platform_agent_templates",
  "platform_connector_templates",
] as const;

const TABLE_OF: Record<ComponentKind, (typeof COMPONENT_TABLES)[number]> = {
  skill: "platform_skills",
  agent_template: "platform_agent_templates",
  connector_template: "platform_connector_templates",
};

interface OwnedRow {
  id: string;
  name: string;
  owner_org_id: string | null;
  shareable: boolean;
  scope: "all" | "optional" | "named";
  awaiting_confirmation: boolean;
}

/** The hash of a delete preview: sha256 over its outcome and sorted ids. */
function previewHashOf(p: Omit<OwnedDeletePreview, "previewHash">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        outcome: p.outcome,
        orgs: p.orgs.map((o) => o.id).sort(),
        agents: p.agents.map((a) => a.id).sort(),
      }),
    )
    .digest("hex");
}

/**
 * The owner org's actions on the items it owns (P3-17: it toggles 可共享, switches the item off in
 * its own org and deletes it; it never changes the scope or the list). The org admin is re-checked
 * under the org row lock; another org's or a platform item -> 404. Stateless, shared by every
 * replica.
 */
@Injectable()
export class OwnedItems {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
    /** The owner org's own uninstall of a removed plugin (ruling P3-41). */
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    /** The owner's org skill row, soft-deleted after its promoted platform row leaves it. */
    @Inject(SkillsService) private readonly skills: SkillsService,
    /** The removed plugin's cleanup job (`owned-plugin-cleanup-<itemId>`, P3-20). */
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) private readonly queue: Pick<Queue, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * The owner org's 可共享 flag of its item, written on the item and (a plugin) every component
   * row in one transaction (ruling P3-2; turning it off narrows as ruling P3-25 says). A skill or
   * an agent template is named by the org row's id (`skills.manage` / `catalog.upload`): only the
   * org's own rows (ruling P3-6: not an agent's skill, not a copy of another owner's platform item:
   * 409 `catalog.not_owned`); one it promoted writes its platform row too (pre-flight F16). Audits
   * `catalog.shareable_changed`.
   */
  @Transactional()
  async setShareable(
    orgId: string,
    actor: string,
    ref: OwnedRef,
    shareable: boolean,
    opts: ActorOpts = {},
  ): Promise<void> {
    if (ref.kind !== "plugin") {
      await this.setComponentShareable(orgId, actor, ref.kind, ref.id, shareable, opts);
      return;
    }
    await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.upload");
    const item = await this.ownedRow(orgId, ref.id, true);
    await this.scope.setShareable(item.id, shareable, actor);
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId,
      action: "catalog.shareable_changed",
      target: item.id,
      detail: { name: item.name, shareable },
    });
  }

  /** {@link setShareable} of an org skill or agent template (named by the org row's id). */
  private async setComponentShareable(
    orgId: string,
    actor: string,
    kind: "skill" | "agent_template",
    id: string,
    shareable: boolean,
    opts: ActorOpts,
  ): Promise<void> {
    await this.orgLock.lockAndAuthorize(
      orgId,
      actor,
      kind === "skill" ? "skills.manage" : "catalog.upload",
    );
    const row = await this.ownedComponent(orgId, kind, id, true);
    if (kind === "skill") {
      await this.db.updateTable("skills").set({ shareable }).where("id", "=", row.id).execute();
    } else {
      await this.db
        .updateTable("agent_templates")
        .set({ shareable })
        .where("id", "=", row.id)
        .execute();
    }
    // promoted: the platform row is the one every gate reads (ruling P3-2), written in this
    // transaction; turning it off narrows an optional / all scope (ruling P3-25)
    if (row.link !== null) {
      const [c] = await loadComponents(this.db, kind, { ids: [row.link], forUpdate: true });
      if (c) {
        await this.db
          .updateTable(TABLE_OF[kind] as "platform_skills")
          .set({ shareable, updated_at: sql<Date>`now()` as unknown as Date })
          .where("id", "=", c.id)
          .execute();
        if (!shareable) await narrowComponentOnUnshare(this.db, actor, c);
      }
    }
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId,
      action: "catalog.shareable_changed",
      target: row.id,
      detail: {
        kind,
        name: row.name,
        shareable,
        ...(row.link !== null && { platformId: row.link }),
      },
    });
  }

  /** The other live orgs the item is on in (P3-18, {@link orgsUsing}), by name. */
  async usedByOthers(ref: OwnedRef): Promise<{ id: string; name: string }[]> {
    const row =
      ref.kind === "plugin"
        ? await this.db
            .selectFrom("catalog_items")
            .select("owner_org_id")
            .where("id", "=", ref.id)
            .where("deleted_at", "is", null)
            .executeTakeFirst()
        : await this.db
            .selectFrom(TABLE_OF[ref.kind] as "platform_skills")
            .select("owner_org_id")
            .where("id", "=", ref.id)
            .where("deleted_at", "is", null)
            .executeTakeFirst();
    if (!row) return [];
    return orgsUsing(this.db, ref, { except: row.owner_org_id });
  }

  /**
   * What deleting the org's skill `skillId` does (pre-flight F19, P3-19): one it promoted that
   * another org uses is `transferred` (`orgs`: those orgs), else `removed`; `agents`: the org's
   * agents that lose it (by its id, or its platform id). Not an org-scope skill of the org -> 404
   * `skill.not_found`.
   */
  async previewSkillDelete(orgId: string, skillId: string): Promise<OwnedSkillDeletePreview> {
    const row = await this.orgSkill(orgId, skillId, false);
    const orgs =
      row.link === null
        ? []
        : await orgsUsing(
            this.db,
            { kind: "skill", id: row.link },
            {
              except: orgId,
            },
          );
    const agents = await agentsUsing(this.db, orgId, "skill", [row.link ?? row.id]);
    return {
      outcome: orgs.length > 0 ? "transferred" : "removed",
      orgs,
      agents: agents
        .map((a) => ({ id: a.id, name: a.name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    };
  }

  /**
   * The owner deletes its org skill (`DELETE orgs/:orgId/skills/:id`, `skills.manage` re-checked
   * under the org row lock): one it promoted goes through {@link transferOrRemove} with reason
   * `owner_deleted` (another org using it keeps it, now the platform's), then the org row is
   * soft-deleted as before (audit `skill.deleted`). Not an org-scope skill of the org -> 404.
   */
  @Transactional()
  async deleteSkill(
    orgId: string,
    actor: string,
    skillId: string,
    opts: ActorOpts = {},
  ): Promise<"transferred" | "removed"> {
    await this.orgLock.lockAndAuthorize(orgId, actor, "skills.manage");
    const row = await this.orgSkill(orgId, skillId, true);
    const outcome =
      row.link === null
        ? "removed"
        : await this.transferOrRemove(
            { kind: "skill", id: row.link },
            "owner_deleted",
            actor,
            opts,
          );
    await this.skills.deleteOrgSkillIn(orgId, row.id, actor, opts.actorTokenId);
    return outcome;
  }

  /**
   * The org-scope skill `skillId` of the org (`forUpdate`: row locked), with the platform row it
   * promoted (`link`; a copy of another owner's platform skill has none here). Missing -> 404.
   */
  private async orgSkill(
    orgId: string,
    skillId: string,
    forUpdate: boolean,
  ): Promise<OwnedComponentRow> {
    let q = this.db
      .selectFrom("skills as s")
      .leftJoin("platform_skills as p", "p.id", "s.platform_skill_id")
      .select(["s.id", "s.name", "s.platform_skill_id", "s.pinned_version", "p.owner_org_id"])
      .where("s.id", "=", skillId)
      .where("s.org_id", "=", orgId)
      .where("s.scope", "=", "org")
      .where("s.deleted_at", "is", null);
    if (forUpdate) q = q.forUpdate("s");
    const r = await q.executeTakeFirst();
    if (!r) throw skillNotFound();
    const promoted =
      r.platform_skill_id !== null && r.pinned_version === null && r.owner_org_id === orgId;
    return { id: r.id, name: r.name, link: promoted ? r.platform_skill_id : null };
  }

  /**
   * The org's own skill or agent template `id` (ruling P3-6), locked with `forUpdate`: missing
   * (or another org's) -> 404; an agent's own skill, or a copy linked to a platform item another
   * owner has (or pinned to one) -> 409 `catalog.not_owned`. `link`: the platform row it promoted.
   */
  private async ownedComponent(
    orgId: string,
    kind: "skill" | "agent_template",
    id: string,
    forUpdate: boolean,
  ): Promise<OwnedComponentRow> {
    const r =
      kind === "skill"
        ? await (() => {
            let q = this.db
              .selectFrom("skills as s")
              .leftJoin("platform_skills as p", "p.id", "s.platform_skill_id")
              .select([
                "s.id",
                "s.name",
                "s.scope",
                "s.platform_skill_id as link",
                "s.pinned_version",
                "p.owner_org_id",
              ])
              .where("s.id", "=", id)
              .where("s.org_id", "=", orgId)
              .where("s.deleted_at", "is", null);
            if (forUpdate) q = q.forUpdate("s");
            return q.executeTakeFirst();
          })()
        : await (() => {
            let q = this.db
              .selectFrom("agent_templates as t")
              .leftJoin("platform_agent_templates as p", "p.id", "t.platform_template_id")
              .select([
                "t.id",
                "t.name",
                sql<"org">`'org'`.as("scope"),
                "t.platform_template_id as link",
                "t.pinned_version",
                "p.owner_org_id",
              ])
              .where("t.id", "=", id)
              .where("t.org_id", "=", orgId)
              .where("t.deleted_at", "is", null);
            if (forUpdate) q = q.forUpdate("t");
            return q.executeTakeFirst();
          })();
    if (!r) throw kind === "skill" ? skillNotFound() : componentNotFound();
    if (r.scope !== "org") throw notOwnedError(`Skill ${r.name} belongs to an agent and`);
    if (r.link === null) return { id: r.id, name: r.name, link: null };
    if (r.pinned_version !== null || r.owner_org_id !== orgId) throw notOwnedError(r.name);
    return { id: r.id, name: r.name, link: r.link };
  }

  /** The preview of deleting the org's own plugin (nothing written). */
  async previewDelete(orgId: string, itemId: string): Promise<OwnedDeletePreview> {
    return this.computeDelete(orgId, await this.ownedRow(orgId, itemId, false));
  }

  /**
   * Deletes the org's own plugin after its preview (P3-19): the preview recomputed under the item
   * row lock must give `previewHash` (else 409 `catalog.preview_stale`), then
   * {@link transferOrRemove} with reason `owner_deleted`.
   */
  @Transactional()
  async delete(
    orgId: string,
    actor: string,
    itemId: string,
    previewHash: string,
    opts: ActorOpts = {},
  ): Promise<"transferred" | "removed"> {
    await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.upload");
    const item = await this.ownedRow(orgId, itemId, true);
    if ((await this.computeDelete(orgId, item)).previewHash !== previewHash) throw previewStale();
    return this.transferOrRemove({ kind: "plugin", id: itemId }, "owner_deleted", actor, opts);
  }

  /**
   * The owner leaves its item, in the caller's transaction (P3-19, P3-20; pre-flight F14, F15).
   * Another live org uses it ({@link orgsUsing}) -> `transferred`: the item and its components
   * become platform-owned, a pending version is cleared, `shown_to_others` is turned off when the
   * owner had not made it shareable (no exposure the owner switched off), the former owner leaves
   * the list and its switches (an `all` scope, the item's or a component's own, is narrowed to
   * `named` = the orgs using it, ruling P3-39; an `optional` item stays `optional`, ruling P3-40:
   * it passed the share gate already, so every org could see it, and the former owner is then an
   * ordinary org that may switch it on again), written
   * directly rather than through the guarded scope writer (ruling P3-27); platform notice
   * `ownership_transferred`, audit `catalog.ownership_transferred`, the scope sync enqueued after
   * the commit (it uninstalls the former owner's install). Otherwise -> `removed`: the soft delete
   * of `catalog.remove` ({@link CatalogService.removeIn}) and, after the commit, the cleanup job
   * `owned-plugin-cleanup-<itemId>` that takes its extension out; an owner delete
   * (`owner_deleted`) also uninstalls it in the owner org through the normal uninstall, keeping the
   * connectors it created as the org's own (ruling P3-41). A first upload still waiting is never
   * transferred. A gone or platform item -> 404.
   */
  @Transactional({ propagation: "mandatory" })
  async transferOrRemove(
    ref: OwnedRef,
    reason: OwnerLeaveReason,
    actor: string | null,
    opts: ActorOpts = {},
  ): Promise<"transferred" | "removed"> {
    if (ref.kind !== "plugin")
      return this.transferOrRemoveComponent(ref.kind, ref.id, reason, actor, opts);
    const t = this.db;
    const item = await t
      .selectFrom("catalog_items")
      .select(["id", "name", "owner_org_id", "shareable", "scope", "awaiting_confirmation"])
      .where("id", "=", ref.id)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!item || item.owner_org_id === null) throw notFound();
    const owner = item.owner_org_id;
    const others = item.awaiting_confirmation ? [] : await orgsUsing(t, ref, { except: owner });
    if (others.length === 0) {
      await this.catalog.removeIn(actor, item.id, { ...opts, reason });
      if (reason === "owner_deleted") await this.uninstallInOwner(owner, actor, item.id, opts);
      afterCommit(() => this.enqueueCleanup(item.id));
      return "removed";
    }
    // Read before anything changes: where each own-scope `all` component is on (P3-39)
    const narrow: { c: ComponentRow; orgs: string[] }[] = [];
    for (const kind of COMPONENT_KINDS) {
      for (const c of await loadComponents(t, kind, { itemId: item.id, forUpdate: true })) {
        if (c.scopeMode === "own" && c.scope === "all") {
          narrow.push({ c, orgs: await this.componentOrgsOn(c, owner) });
        }
      }
    }
    const now = sql<Date>`now()` as unknown as Date;
    await t
      .updateTable("catalog_items")
      .set({
        owner_org_id: null,
        pending_version: null,
        pending_by: null,
        pending_at: null,
        ...(!item.shareable && { shown_to_others: false }),
        ...(item.scope === "all" && { scope: "named" as const }),
        scope_version: sql<number>`scope_version + 1`,
        updated_at: now,
      })
      .where("id", "=", item.id)
      .execute();
    if (item.scope === "all") {
      await t.deleteFrom("catalog_item_scope_orgs").where("item_id", "=", item.id).execute();
      await t
        .insertInto("catalog_item_scope_orgs")
        .values(others.map((o) => ({ item_id: item.id, org_id: o.id })))
        .execute();
    } else {
      await t
        .deleteFrom("catalog_item_scope_orgs")
        .where("item_id", "=", item.id)
        .where("org_id", "=", owner)
        .execute();
    }
    await t
      .deleteFrom("catalog_item_org_switches")
      .where("item_id", "=", item.id)
      .where("org_id", "=", owner)
      .execute();
    for (const table of COMPONENT_TABLES) {
      await t
        .updateTable(table as "platform_skills")
        .set({ owner_org_id: null, ...(!item.shareable && { shown_to_others: false }) })
        .where("catalog_item_id", "=", item.id)
        .execute();
    }
    for (const kind of COMPONENT_KINDS) {
      const ids = (await loadComponents(t, kind, { itemId: item.id })).map((c) => c.id);
      if (ids.length === 0) continue;
      for (const table of ["component_scope_orgs", "component_org_switches"] as const) {
        await t
          .deleteFrom(table as "component_scope_orgs")
          .where("kind", "=", kind)
          .where("component_id", "in", ids)
          .where("org_id", "=", owner)
          .execute();
      }
    }
    for (const { c, orgs } of narrow) {
      await t
        .updateTable(TABLE_OF[c.kind] as "platform_skills")
        .set({ scope: "named", scope_version: sql<number>`scope_version + 1`, updated_at: now })
        .where("id", "=", c.id)
        .execute();
      await t
        .deleteFrom("component_scope_orgs")
        .where("kind", "=", c.kind)
        .where("component_id", "=", c.id)
        .execute();
      if (orgs.length > 0) {
        await t
          .insertInto("component_scope_orgs")
          .values(orgs.map((org_id) => ({ kind: c.kind, component_id: c.id, org_id })))
          .execute();
      }
      await audit(t, {
        actorAccountId: actor,
        action: "component.scope_changed",
        target: c.id,
        detail: {
          kind: c.kind,
          name: c.name,
          plugin: c.plugin,
          from: { scopeMode: "own", scope: "all", orgs: [] },
          to: { scopeMode: "own", scope: "named", orgs },
          reason: "ownership_transferred",
        },
      });
    }
    const from = await t
      .selectFrom("orgs")
      .select(["id", "name"])
      .where("id", "=", owner)
      .executeTakeFirst();
    await addPlatformNotice(t, "ownership_transferred", {
      ref,
      name: item.name,
      fromOrg: from ?? { id: owner, name: owner },
      reason,
      usedBy: others.length,
    });
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId: owner,
      action: "catalog.ownership_transferred",
      target: item.id,
      detail: { name: item.name, fromOrgId: owner, reason, usedBy: others.map((o) => o.id) },
    });
    afterCommit(() => this.scope.enqueueSync(item.id));
    return "transferred";
  }

  /**
   * {@link transferOrRemove} of a platform skill or agent template the org promoted (ruling P3-3;
   * `id` its platform id): another live org uses it -> `transferred`: platform-owned, not shown
   * when the owner had not made it shareable, an `all` scope narrowed to `named` = the orgs using
   * it (ruling P3-39), the former owner off its list and switches, platform notice
   * `ownership_transferred`, audit `catalog.ownership_transferred`. Otherwise `removed`: the
   * platform row is soft-deleted (audit `component.removed`). The owner's org row is the caller's
   * (an owner delete soft-deletes it). Gone or platform-owned -> 404.
   */
  private async transferOrRemoveComponent(
    kind: "skill" | "agent_template",
    id: string,
    reason: OwnerLeaveReason,
    actor: string | null,
    opts: ActorOpts,
  ): Promise<"transferred" | "removed"> {
    const t = this.db;
    const [c] = await loadComponents(t, kind, { ids: [id], forUpdate: true });
    if (!c || c.ownerOrgId === null) throw componentNotFound();
    const owner = c.ownerOrgId;
    const ref: OwnedRef = { kind, id };
    const others = await orgsUsing(t, ref, { except: owner });
    const now = sql<Date>`now()` as unknown as Date;
    const table = TABLE_OF[kind] as "platform_skills";
    if (others.length === 0) {
      await t
        .updateTable(table)
        .set({ deleted_at: now, updated_at: now })
        .where("id", "=", id)
        .execute();
      await audit(t, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        orgId: owner,
        action: "component.removed",
        target: id,
        detail: { kind, name: c.name, reason },
      });
      return "removed";
    }
    // read before anything changes: where an own `all` scope is on (P3-39)
    const narrowTo =
      c.scopeMode === "own" && c.scope === "all" ? await this.componentOrgsOn(c, owner) : null;
    await t
      .updateTable(table)
      .set({
        owner_org_id: null,
        ...(!c.shareable && { shown_to_others: false }),
        ...(narrowTo !== null && {
          scope: "named" as const,
          scope_version: sql<number>`scope_version + 1`,
        }),
        updated_at: now,
      })
      .where("id", "=", id)
      .execute();
    if (narrowTo !== null) {
      await t
        .deleteFrom("component_scope_orgs")
        .where("kind", "=", kind)
        .where("component_id", "=", id)
        .execute();
      if (narrowTo.length > 0) {
        await t
          .insertInto("component_scope_orgs")
          .values(narrowTo.map((org_id) => ({ kind, component_id: id, org_id })))
          .execute();
      }
    }
    for (const list of ["component_scope_orgs", "component_org_switches"] as const) {
      await t
        .deleteFrom(list as "component_scope_orgs")
        .where("kind", "=", kind)
        .where("component_id", "=", id)
        .where("org_id", "=", owner)
        .execute();
    }
    const from = await t
      .selectFrom("orgs")
      .select(["id", "name"])
      .where("id", "=", owner)
      .executeTakeFirst();
    await addPlatformNotice(t, "ownership_transferred", {
      ref,
      name: c.name,
      fromOrg: from ?? { id: owner, name: owner },
      reason,
      usedBy: others.length,
    });
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId: owner,
      action: "catalog.ownership_transferred",
      target: id,
      detail: {
        kind,
        name: c.name,
        fromOrgId: owner,
        reason,
        usedBy: others.map((o) => o.id),
        ...(narrowTo !== null && { narrowedTo: narrowTo }),
      },
    });
    return "transferred";
  }

  /** The live orgs other than `except` where component `c` is on now ({@link componentOn}). */
  private async componentOrgsOn(c: ComponentRow, except: string): Promise<string[]> {
    const st = await loadScopeState(this.db, c.kind, [c]);
    const orgs = await this.db
      .selectFrom("orgs")
      .select("id")
      .where("deleted_at", "is", null)
      .where("id", "!=", except)
      .orderBy("id")
      .execute();
    return orgs
      .map((o) => o.id)
      .filter((o) =>
        componentOn(
          c,
          pluginFactsOf(st, c.itemId, o),
          listedIn(st, c.id, o),
          switchOf(st, c.id, o),
        ),
      );
  }

  /**
   * The owner org's live install of a removed plugin, uninstalled in the caller's transaction
   * through the normal uninstall (ruling P3-41): `via: "scope"` (the item is gone, so no scope
   * wants it), which keeps the connectors it created as the org's own. One that another install
   * still depends on, or one still installing, stays (logged).
   */
  private async uninstallInOwner(
    owner: string,
    actor: string | null,
    itemId: string,
    opts: ActorOpts,
  ): Promise<void> {
    const live = await this.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("org_id", "=", owner)
      .where("item_id", "=", itemId)
      .where("status", "=", "installed")
      .executeTakeFirst();
    if (live === undefined) return;
    try {
      await this.installer.uninstall(owner, actor, live.id, {
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        via: "scope",
      });
    } catch (e) {
      if (!(e instanceof ScopeStillWanted)) throw e;
      this.log.info("the removed plugin's install stays: another install depends on it", {
        orgId: owner,
        itemId,
      });
    }
  }

  /** Enqueues the removed plugin's cleanup; a failure only warns (the daily sweep repairs it). */
  async enqueueCleanup(itemId: string): Promise<void> {
    const job = ownedPluginCleanupJob(itemId);
    try {
      await this.queue.add(job.name, job.data, job.opts);
    } catch (err) {
      this.log.warn("enqueueing the owned plugin cleanup failed", { itemId, err });
    }
  }

  private async computeDelete(orgId: string, item: OwnedRow): Promise<OwnedDeletePreview> {
    const ref: OwnedRef = { kind: "plugin", id: item.id };
    const orgs = item.awaiting_confirmation ? [] : await orgsUsing(this.db, ref, { except: orgId });
    const agents = new Map<string, string>();
    for (const kind of COMPONENT_KINDS) {
      const ids = (await loadComponents(this.db, kind, { itemId: item.id })).map((c) => c.id);
      for (const a of await agentsUsing(this.db, orgId, kind, ids)) agents.set(a.id, a.name);
    }
    const p = {
      outcome: orgs.length > 0 ? ("transferred" as const) : ("removed" as const),
      orgs,
      agents: [...agents]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    };
    return { ...p, previewHash: previewHashOf(p) };
  }

  /** The org's own live plugin (`forUpdate`: row locked); another org's or a platform one -> 404. */
  private async ownedRow(orgId: string, itemId: string, forUpdate: boolean): Promise<OwnedRow> {
    if (!UUID_RE.test(itemId)) throw notFound();
    let q = this.db
      .selectFrom("catalog_items")
      .select(["id", "name", "owner_org_id", "shareable", "scope", "awaiting_confirmation"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row || row.owner_org_id !== orgId) throw notFound();
    return row;
  }
}
