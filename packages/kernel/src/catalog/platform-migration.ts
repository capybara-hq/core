// The migration of what exists to platform components (plugin scope phase 2, Task 5; spec §6
// "Migration of what exists" and §13.5): the platform rows of every catalog item that has none,
// org copies of plugin skills and agent templates linked to them (ruling B2), clashing org skills
// renamed, and connectors linked to their platform connector template (ruling E2). Each step only
// touches rows that still need it, so the job runs at every worker start (ruling P2-2: it also heals
// an item whose sync after its import failed) and once a day, and a run with nothing to do only
// reads.
import { randomUUID } from "node:crypto";
import { isSkillName } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { platformTemplatesOn } from "../agents/templates.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { platformSkillsOn } from "../skills/usable.js";
import { canonicalJson } from "../tools/canonical-json.js";
import { skillFilesDigest } from "./catalog-content.js";
import { PlatformComponents } from "./platform-components.js";
import { compareVersions } from "./versions.js";

/** The job's name (`@LockedInterval`, run lock `cron:platform-components-migrate`). */
export const PLATFORM_MIGRATION_JOB = "platform-components-migrate";

/** Besides every worker start, the job runs once a day (a heal: normally nothing to do). */
const PERIOD_MS = 24 * 3600_000;

/** Finished runs are kept this long (the first one always: it marks the migration as done). */
const RUNS_KEPT_MS = 30 * 24 * 3600_000;

/** The run lock's lifetime without renewal (renewed while a run lasts). */
const LOCK_TTL_MS = 60_000;

/** Plugin install statuses of a plugin that is on in the org (phase 1, org catalog state). */
const LIVE_INSTALL = ["installing", "installed", "upgrading"] as const;

/** The audit action and inbox notice of a renamed skill. */
export const SKILL_RENAMED = "skill_renamed";

/** What one run changed (also stored in `platform_migration_runs.stats`). */
export interface PlatformMigrationStats {
  /** Catalog items whose platform rows were written (`<name>@<version>`). */
  itemsSynced: string[];
  /** Catalog items whose sync failed (logged; tried again by the next run). */
  itemsFailed: string[];
  /** Org skill copies linked to their platform skill, and how many of them were pinned. */
  skillsLinked: number;
  skillsPinned: number;
  /** Org skills renamed because a platform skill of the same name is on in their org. */
  skillsRenamed: number;
  /** Org template copies linked to their platform template, and how many of them were pinned. */
  templatesLinked: number;
  templatesPinned: number;
  /** Connectors linked to the platform connector template they were made from. */
  connectorsLinked: number;
}

const emptyStats = (): PlatformMigrationStats => ({
  itemsSynced: [],
  itemsFailed: [],
  skillsLinked: 0,
  skillsPinned: 0,
  skillsRenamed: 0,
  templatesLinked: 0,
  templatesPinned: 0,
  connectorsLinked: 0,
});

/** A copy to link: the org row, the platform row it belongs to, and whether it keeps its version. */
interface Link {
  id: string;
  version: number;
  platformId: string;
  pin: boolean;
}

/** An org skill whose name a platform skill on in its org also has. */
interface Clash {
  skillId: string;
  name: string;
  platform: { id: string; plugin: string | null }[];
}

/**
 * The name a renamed skill gets: `<name>-org`, then `-org-2`, `-org-3`, … (the base shortened
 * when the result would be longer than a skill name may be), the first one not in `taken`.
 */
export function renamedSkillName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "-org" : `-org-${n}`;
    let base = name;
    while (base !== "" && !isSkillName(`${base}${suffix}`)) {
      base = base.slice(0, -1).replace(/-+$/, "");
    }
    const candidate = `${base === "" ? "skill" : base}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The platform components migration (spec §6, §13.5), a worker job (`platform-components-migrate`,
 * `@LockedInterval` with `runOnStart`: once across replicas at every worker start, then daily).
 * Steps, each on the rows that still need it:
 * 1. every live catalog item never synced (`platform_synced_version` null) gets its platform rows
 *    (`syncFromVersion`, which records the version) at the highest
 *    version installed in an org (spec §6: "the plugin's version becomes the highest installed
 *    one"), else its latest version;
 * 2. an org skill copy with plugin provenance (on the skill and its current version) links to the
 *    platform skill of its plugin and name; it is pinned to its own current version when its files
 *    differ from the platform version's. A copy whose platform skill is not on in its org is left
 *    unlinked (it keeps serving what it served) until a later run finds it on: a linked copy,
 *    pinned or not, follows its platform skill's availability (ruling P2-18);
 * 3. one-shot (spec §5 rule 10, ruling P2-5: nothing is renamed outside the migration): only while
 *    no run has finished (the first run's own execution), an org skill of the org's own (no
 *    provenance) whose name a platform skill on in its org has stays the org's: it is renamed (`<name>-org`, `-org-2`, …), the org admins get an inbox notice
 *    (`skill_renamed`) and that platform skill is switched off in the org (a switch the org already
 *    has is kept). Agents select skills by id, so they keep it; the name changes in new runs. Once a
 *    run has finished, a clash is only logged as a warning and left alone (the org's skill wins);
 * 4. an org agent template links to the platform template of its plugin and name, pinned like
 *    skills (definitions compared as canonical JSON). Templates are never renamed: an org template
 *    always has its plugin's type, which is the platform template's;
 * 5. a connector made from a connector template (the install ledger's `template_id`) links to that
 *    platform connector template (ruling E2).
 * Plugin switches exist since phase 1 and new platform rows follow the plugin's scope, so nothing
 * else is written. Writes run per org under its row lock and re-check each row; nothing is deleted
 * or overwritten except the renamed skill's name. Each run is recorded in `platform_migration_runs`
 * (rows older than 30 days are pruned, except the first finished run: it marks the renames done).
 */
@Injectable()
export class PlatformMigration {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(PlatformComponents) private readonly platform: PlatformComponents,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** The scheduled run (see the class). */
  @LockedInterval(PLATFORM_MIGRATION_JOB, () => PERIOD_MS, {
    runOnStart: true,
    ttl: LOCK_TTL_MS,
  })
  async migrate(signal?: AbortSignal): Promise<void> {
    await this.runOnce(signal);
  }

  /**
   * One run of every step; returns what it changed. `signal` (the stop, or a lost run lock) is
   * read between items and orgs: an aborted run stops there and its row is deleted (every step is
   * idempotent, so the next run carries on; an unfinished run never counts as the first one).
   */
  async runOnce(signal?: AbortSignal): Promise<PlatformMigrationStats> {
    const runId = randomUUID();
    await this.db.insertInto("platform_migration_runs").values({ id: runId }).execute();
    const first = await this.db
      .selectFrom("platform_migration_runs")
      .select("started_at")
      .where("finished_at", "is not", null)
      .orderBy("started_at")
      .limit(1)
      .executeTakeFirst();
    const stats = emptyStats();
    const steps = [
      () => this.syncItems(stats, signal),
      () => this.linkSkills(stats, signal),
      () => this.renameClashes(stats, first === undefined, signal),
      () => this.linkTemplates(stats, signal),
      () => this.linkConnectors(stats),
    ];
    for (const step of steps) {
      if (signal?.aborted) {
        await this.db.deleteFrom("platform_migration_runs").where("id", "=", runId).execute();
        this.log.info("platform components migration stopped early", { runId, ...stats });
        return stats;
      }
      await step();
    }
    await this.db
      .updateTable("platform_migration_runs")
      .set({ finished_at: new Date(), stats: JSON.stringify(stats) })
      .where("id", "=", runId)
      .execute();
    await this.pruneRuns(first?.started_at);
    const changed =
      stats.itemsSynced.length +
        stats.skillsLinked +
        stats.skillsRenamed +
        stats.templatesLinked +
        stats.connectorsLinked >
      0;
    if (changed || stats.itemsFailed.length > 0) {
      this.log.info("platform components migrated", { runId, ...stats });
    }
    return stats;
  }

  /** Deletes finished runs older than {@link RUNS_KEPT_MS}, never the first one (`first`). */
  private async pruneRuns(first: Date | undefined): Promise<void> {
    let q = this.db
      .deleteFrom("platform_migration_runs")
      .where("finished_at", "is not", null)
      .where("started_at", "<", new Date(Date.now() - RUNS_KEPT_MS));
    if (first !== undefined) q = q.where("started_at", ">", first);
    await q.execute();
  }

  /**
   * Step 1: the live catalog items whose platform components were never written
   * (`platform_synced_version` null; `syncFromVersion` sets it). An item whose components were
   * removed since is not synced again.
   */
  private async syncItems(stats: PlatformMigrationStats, signal?: AbortSignal): Promise<void> {
    const items = await this.db
      .selectFrom("catalog_items as i")
      .select(["i.id", "i.name", "i.latest_version"])
      .where("i.deleted_at", "is", null)
      .where("i.platform_synced_version", "is", null)
      // an org upload waiting for the super admin gets its components at the confirmation (P3-9)
      .where("i.awaiting_confirmation", "=", false)
      .orderBy("i.name")
      .execute();
    for (const item of items) {
      if (signal?.aborted) return;
      const version = await this.platformVersion(item.id, item.latest_version);
      try {
        const r = await this.platform.syncFromVersion(item.id, version, { initial: false });
        if (r.skills.length + r.agentTemplates.length + r.connectorTemplates.length > 0) {
          stats.itemsSynced.push(`${item.name}@${version}`);
        }
      } catch (err) {
        stats.itemsFailed.push(`${item.name}@${version}`);
        this.log.warn("platform components of a catalog item not written", {
          itemId: item.id,
          plugin: item.name,
          version,
          err,
        });
      }
    }
  }

  /** The highest version of the item installed in an org (and still stored), else `latest`. */
  private async platformVersion(itemId: string, latest: string): Promise<string> {
    const rows = await this.db
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_item_versions as v", (j) =>
        j.onRef("v.item_id", "=", "a.item_id").onRef("v.version", "=", "a.version"),
      )
      .innerJoin("orgs as o", "o.id", "a.org_id")
      .select("a.version")
      .distinct()
      .where("a.item_id", "=", itemId)
      .where("a.status", "in", [...LIVE_INSTALL])
      .where("o.deleted_at", "is", null)
      .execute();
    const highest = rows
      .map((r) => ({ version: r.version }))
      .sort((a, b) => compareVersions(b, a))[0];
    return highest?.version ?? latest;
  }

  /** Step 2: org skill copies with plugin provenance, not linked yet. */
  private async linkSkills(stats: PlatformMigrationStats, signal?: AbortSignal): Promise<void> {
    const rows = await this.db
      .selectFrom("skills as s")
      .innerJoin("skill_versions as v", (j) =>
        j.onRef("v.skill_id", "=", "s.id").onRef("v.version", "=", "s.current_version"),
      )
      .innerJoin("catalog_items as c", "c.id", "s.catalog_item_id")
      .innerJoin("platform_skills as p", (j) =>
        j.onRef("p.plugin_name", "=", "c.name").onRef("p.name", "=", "s.name"),
      )
      .innerJoin("platform_skill_versions as pv", (j) =>
        j.onRef("pv.skill_id", "=", "p.id").onRef("pv.version", "=", "p.current_version"),
      )
      .select([
        "s.id",
        "s.org_id",
        "s.current_version",
        "v.manifest",
        "p.id as platform_id",
        "pv.manifest as platform_manifest",
      ])
      .where("s.scope", "=", "org")
      .where("s.deleted_at", "is", null)
      .where("s.platform_skill_id", "is", null)
      .whereRef("v.catalog_item_id", "=", "s.catalog_item_id")
      .where("p.deleted_at", "is", null)
      .orderBy("s.org_id")
      .orderBy("s.id")
      .execute();
    for (const [orgId, list] of groupBy(rows, (r) => r.org_id)) {
      if (signal?.aborted) return;
      const on = await platformSkillsOn(
        this.db,
        orgId,
        list.map((r) => r.platform_id),
      );
      // a copy whose platform skill is off in its org stays the org's own until it is on: a
      // linked copy, pinned or not, follows its platform skill's availability (ruling P2-18)
      const links = list
        .filter((r) => on.has(r.platform_id))
        .map(
          (r): Link => ({
            id: r.id,
            version: r.current_version,
            platformId: r.platform_id,
            pin: skillFilesDigest(r.manifest.files) !== skillFilesDigest(r.platform_manifest.files),
          }),
        );
      const done = await this.linkSkillsIn(orgId, links);
      stats.skillsLinked += done.length;
      stats.skillsPinned += done.filter((l) => l.pin).length;
    }
  }

  /** Links `links` of one org under its row lock (each only while it is still as read). */
  @Transactional()
  private async linkSkillsIn(orgId: string, links: Link[]): Promise<Link[]> {
    if (!(await this.orgLock.tryLock(orgId))) return [];
    const done: Link[] = [];
    for (const l of links) {
      const r = await this.db
        .updateTable("skills")
        .set({ platform_skill_id: l.platformId, pinned_version: l.pin ? l.version : null })
        .where("id", "=", l.id)
        .where("org_id", "=", orgId)
        .where("platform_skill_id", "is", null)
        .where("current_version", "=", l.version)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (r.numUpdatedRows > 0n) done.push(l);
    }
    if (done.length > 0) {
      await audit(this.db, {
        orgId,
        action: "skill.platform_linked",
        detail: {
          skills: done.map((l) => ({
            id: l.id,
            platformSkillId: l.platformId,
            pinnedVersion: l.pin ? l.version : null,
          })),
        },
      });
    }
    return done;
  }

  /**
   * Step 3 (one-shot): org skills of the org's own whose name a platform skill on in their org has,
   * renamed only in the first run (`rename`: no run has finished yet); later ones are only logged.
   */
  private async renameClashes(
    stats: PlatformMigrationStats,
    rename: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const rows = await this.db
      .selectFrom("skills as s")
      .innerJoin("skill_versions as v", (j) =>
        j.onRef("v.skill_id", "=", "s.id").onRef("v.version", "=", "s.current_version"),
      )
      .innerJoin("platform_skills as p", "p.name", "s.name")
      .select(["s.id", "s.org_id", "s.name", "p.id as platform_id", "p.plugin_name"])
      .where("s.scope", "=", "org")
      .where("s.deleted_at", "is", null)
      .where("s.platform_skill_id", "is", null)
      .where("s.catalog_item_id", "is", null)
      .where("v.catalog_item_id", "is", null)
      .where("p.deleted_at", "is", null)
      .where("p.disabled", "=", false)
      .orderBy("s.org_id")
      .orderBy("s.id")
      .orderBy("p.id")
      .execute();
    for (const [orgId, list] of groupBy(rows, (r) => r.org_id)) {
      if (signal?.aborted) return;
      const on = await platformSkillsOn(
        this.db,
        orgId,
        list.map((r) => r.platform_id),
      );
      const clashes: Clash[] = [];
      for (const [skillId, pairs] of groupBy(
        list.filter((r) => on.has(r.platform_id)),
        (r) => r.id,
      )) {
        const first = pairs[0] as (typeof pairs)[number];
        if (!rename) {
          this.log.warn(
            "org skill shares its name with a platform skill; not renamed after the migration",
            {
              orgId,
              skillId,
              name: first.name,
              platformSkillIds: pairs.map((r) => r.platform_id),
            },
          );
          continue;
        }
        clashes.push({
          skillId,
          name: (pairs[0] as (typeof pairs)[number]).name,
          platform: pairs.map((r) => ({ id: r.platform_id, plugin: r.plugin_name })),
        });
      }
      if (clashes.length > 0) stats.skillsRenamed += await this.renameIn(orgId, clashes);
    }
  }

  /**
   * Renames the clashing skills of one org under its row lock (each only while it still has the
   * name and no provenance), switches the clashing platform skills off in the org (unless the org
   * has a switch for them already), and writes one inbox notice and one audit event per skill.
   */
  @Transactional()
  private async renameIn(orgId: string, clashes: Clash[]): Promise<number> {
    if (!(await this.orgLock.tryLock(orgId))) return 0;
    // Names the new one must avoid: the org's live skills, and every live platform skill (one the
    // org cannot see yet may be switched on later)
    const taken = new Set(
      [
        ...(await this.db
          .selectFrom("skills")
          .select("name")
          .where("org_id", "=", orgId)
          .where("scope", "=", "org")
          .where("deleted_at", "is", null)
          .execute()),
        ...(await this.db
          .selectFrom("platform_skills")
          .select("name")
          .where("deleted_at", "is", null)
          .execute()),
      ].map((r) => r.name),
    );
    let renamed = 0;
    for (const c of clashes) {
      const to = renamedSkillName(c.name, taken);
      const r = await this.db
        .updateTable("skills")
        .set({ name: to, updated_at: sql`now()` })
        .where("id", "=", c.skillId)
        .where("org_id", "=", orgId)
        .where("name", "=", c.name)
        .where("platform_skill_id", "is", null)
        .where("catalog_item_id", "is", null)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) continue;
      taken.add(to);
      renamed++;
      await this.db
        .insertInto("component_org_switches")
        .values(
          c.platform.map((p) => ({
            kind: "skill" as const,
            component_id: p.id,
            org_id: orgId,
            enabled: false,
          })),
        )
        .onConflict((oc) => oc.columns(["kind", "component_id", "org_id"]).doNothing())
        .execute();
      const first = c.platform[0] as Clash["platform"][number];
      const detail = {
        skillId: c.skillId,
        from: c.name,
        to,
        platformSkillId: first.id,
        plugin: first.plugin,
      };
      await this.db
        .insertInto("org_notices")
        .values({
          id: randomUUID(),
          org_id: orgId,
          kind: SKILL_RENAMED,
          detail: JSON.stringify(detail),
        })
        .execute();
      await audit(this.db, {
        orgId,
        action: "skill.renamed",
        target: c.skillId,
        detail: { ...detail, platformSkillIds: c.platform.map((p) => p.id) },
      });
    }
    return renamed;
  }

  /** Step 4: org agent templates not linked yet, by plugin and name. */
  private async linkTemplates(stats: PlatformMigrationStats, signal?: AbortSignal): Promise<void> {
    const rows = await this.db
      .selectFrom("agent_templates as a")
      .innerJoin("agent_template_versions as v", (j) =>
        j.onRef("v.template_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
      )
      .innerJoin("platform_agent_templates as p", (j) =>
        j.onRef("p.plugin_name", "=", "a.plugin_name").onRef("p.name", "=", "a.name"),
      )
      .innerJoin("platform_agent_template_versions as pv", (j) =>
        j.onRef("pv.template_id", "=", "p.id").onRef("pv.version", "=", "p.current_version"),
      )
      .select([
        "a.id",
        "a.org_id",
        "a.current_version",
        "v.definition",
        "p.id as platform_id",
        "pv.definition as platform_definition",
      ])
      .where("a.deleted_at", "is", null)
      .where("a.platform_template_id", "is", null)
      .where("p.deleted_at", "is", null)
      // an org's own template it promoted (ruling P3-3) is no plugin's: other orgs' copies of a
      // plugin template of the same type never link to it
      .where((eb) =>
        eb.or([eb("p.catalog_item_id", "is not", null), eb("p.origin_org_id", "is", null)]),
      )
      .orderBy("a.org_id")
      .orderBy("a.id")
      .execute();
    for (const [orgId, list] of groupBy(rows, (r) => r.org_id)) {
      if (signal?.aborted) return;
      const on = await platformTemplatesOn(
        this.db,
        orgId,
        list.map((r) => r.platform_id),
      );
      // as skills: a copy whose platform template is off in its org stays unlinked (P2-18)
      const links = list
        .filter((r) => on.has(r.platform_id))
        .map(
          (r): Link => ({
            id: r.id,
            version: r.current_version,
            platformId: r.platform_id,
            pin: canonicalJson(r.definition) !== canonicalJson(r.platform_definition),
          }),
        );
      const done = await this.linkTemplatesIn(orgId, links);
      stats.templatesLinked += done.length;
      stats.templatesPinned += done.filter((l) => l.pin).length;
    }
  }

  /** Links `links` of one org under its row lock (each only while it is still as read). */
  @Transactional()
  private async linkTemplatesIn(orgId: string, links: Link[]): Promise<Link[]> {
    if (!(await this.orgLock.tryLock(orgId))) return [];
    const done: Link[] = [];
    for (const l of links) {
      const r = await this.db
        .updateTable("agent_templates")
        .set({ platform_template_id: l.platformId, pinned_version: l.pin ? l.version : null })
        .where("id", "=", l.id)
        .where("org_id", "=", orgId)
        .where("platform_template_id", "is", null)
        .where("current_version", "=", l.version)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (r.numUpdatedRows > 0n) done.push(l);
    }
    if (done.length > 0) {
      await audit(this.db, {
        orgId,
        action: "agent_template.platform_linked",
        detail: {
          templates: done.map((l) => ({
            id: l.id,
            platformTemplateId: l.platformId,
            pinnedVersion: l.pin ? l.version : null,
          })),
        },
      });
    }
    return done;
  }

  /**
   * Step 5: connectors not linked yet whose install ledger row names the connector template they
   * were made from; one statement (a connector only gains a link, nothing else changes).
   */
  private async linkConnectors(stats: PlatformMigrationStats): Promise<void> {
    const made = this.db
      .selectFrom("plugin_install_components as k")
      .innerJoin("plugin_installs as i", "i.id", "k.install_id")
      .innerJoin("platform_connector_templates as p", (j) =>
        j
          .onRef("p.catalog_item_id", "=", "i.item_id")
          .onRef("p.template_id", "=", "k.template_id")
          .on("p.deleted_at", "is", null),
      )
      .distinctOn("k.ref")
      .select(["k.ref as connector_id", "p.id as platform_id"])
      .where("k.kind", "=", "connector")
      .where("k.template_id", "is not", null)
      .orderBy("k.ref")
      .orderBy("i.installed_at", "desc")
      .orderBy("p.id")
      .as("m");
    const r = await this.db
      .updateTable("connectors as c")
      .from(made)
      .set((eb) => ({ platform_template_id: eb.ref("m.platform_id") }))
      .whereRef("c.id", "=", "m.connector_id")
      .where("c.platform_template_id", "is", null)
      .returning("c.id")
      .execute();
    stats.connectorsLinked += r.length;
  }
}

/** `rows` grouped by `key`, in their order. */
function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}
