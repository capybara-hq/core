// The skills an org can use (plugin scope phase 2, Task 3): its own skills plus the platform skills
// (rulings A2, C2) that are on in the org. Org copies linked to a platform skill (ruling B2) resolve
// to the platform skill's current version under their own id unless pinned; platform files are
// read from `deployment/` and their snapshot `source` is `platform:<object prefix>` (ruling D2).
import type { Logger, ObjectStore } from "@capybara-hq/plugin-sdk";
import { wantedOn } from "../catalog/scope.js";
import type { KernelSchemaDb, SkillManifest, SourceFormat } from "../db/kernel-schema.js";

/** The `source` prefix of a platform skill version in a snapshot or an invocation record. */
export const PLATFORM_SOURCE = "platform:";

/** The snapshot `source` of a platform skill version stored at `prefix` (in `deployment/`). */
export const platformSource = (prefix: string): string => `${PLATFORM_SOURCE}${prefix}`;

/**
 * Where the files of a skill version with snapshot `source` live: `deployment/` for a platform
 * version (`platform:<prefix>`), else the org's `kernel/<orgId>/`; `prefix` is the key prefix in
 * that store.
 */
export function skillFileStore(
  storage: { kernel(orgId: string): ObjectStore; deployment(): ObjectStore },
  orgId: string,
  source: string,
): { store: ObjectStore; prefix: string } {
  return source.startsWith(PLATFORM_SOURCE)
    ? { store: storage.deployment(), prefix: source.slice(PLATFORM_SOURCE.length) }
    : { store: storage.kernel(orgId), prefix: source };
}

/** A skill the org can use: one of its own, or a platform skill that is on in the org. */
export interface UsableSkill {
  id: string;
  name: string;
  description: string;
  version: number;
  /** The object prefix of the version (`platform:<prefix>` for a platform version). */
  source: string;
  /** The plugin it came from (a platform skill's plugin, an org skill's provenance). */
  plugin: string | null;
  origin: "org" | "platform";
  /** The platform skill whose content this is (a platform skill, or a linked org copy). */
  platformSkillId?: string;
}

/** A usable or selected skill with what the resolvers need beyond {@link UsableSkill}. */
export interface SkillVersionRow extends UsableSkill {
  /** `agent`: an agent's own skill (never in the org library). Platform skills are `org`. */
  scope: "org" | "agent";
  agentId: string | null;
  manifest: SkillManifest;
  format: SourceFormat;
}

/** Plugin install statuses that make a plugin on in the org (phase 1, org catalog state). */
const LIVE_INSTALL = ["installing", "installed", "upgrading"] as const;

const byNameThenId = (a: UsableSkill, b: UsableSkill): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The platform skills on in the org (`ids`: only those), minus the ones whose name an org skill of
 * its own already uses (rule 10: the org's wins; logged unless that skill is a copy of the same
 * component: linked to it, or carrying the same plugin's provenance before the migration linked
 * it). On in the org:
 * - never when the skill or its plugin is disabled (or its plugin is deleted);
 * - `follow`: its plugin is on in the org (a live install, or builtin) and no component switch of
 *   the org says off;
 * - `own`: `wantedOn` over the skill's own scope, the org's list membership and its switch.
 * One query for the skills with their plugin and org state, one for the org's names.
 */
async function platformOn(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[] | undefined,
  log?: Pick<Logger, "warn">,
): Promise<SkillVersionRow[]> {
  if (ids !== undefined && ids.length === 0) return [];
  let q = db
    .selectFrom("platform_skills as p")
    .innerJoin("platform_skill_versions as v", (j) =>
      j.onRef("v.skill_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
    )
    .leftJoin("catalog_items as c", (j) =>
      j.onRef("c.id", "=", "p.catalog_item_id").on("c.deleted_at", "is", null),
    )
    .select((eb) => [
      "p.id",
      "p.name",
      "p.plugin_name",
      "p.catalog_item_id",
      "p.current_version",
      "p.scope_mode",
      "p.scope",
      "v.manifest",
      "v.object_prefix",
      "v.source_format",
      "c.id as item_id",
      "c.disabled as item_disabled",
      "c.builtin as item_builtin",
      eb
        .exists(
          eb
            .selectFrom("plugin_installs as a")
            .select("a.id")
            .whereRef("a.item_id", "=", "p.catalog_item_id")
            .where("a.org_id", "=", orgId)
            .where("a.status", "in", [...LIVE_INSTALL]),
        )
        .as("installed"),
      eb
        .exists(
          eb
            .selectFrom("component_scope_orgs as l")
            .select("l.org_id")
            .where("l.kind", "=", "skill")
            .whereRef("l.component_id", "=", "p.id")
            .where("l.org_id", "=", orgId),
        )
        .as("listed"),
      eb
        .selectFrom("component_org_switches as w")
        .select("w.enabled")
        .where("w.kind", "=", "skill")
        .whereRef("w.component_id", "=", "p.id")
        .where("w.org_id", "=", orgId)
        .as("switch"),
    ])
    .where("p.deleted_at", "is", null)
    .where("p.disabled", "=", false);
  if (ids !== undefined) q = q.where("p.id", "in", [...ids]);
  const rows = (await q.execute()).filter((r) => {
    const sw = r.switch ?? null;
    if (r.item_disabled === true) return false;
    if (r.scope_mode === "follow") {
      return (
        r.item_id !== null && (Boolean(r.installed) || r.item_builtin === true) && sw !== false
      );
    }
    return wantedOn({ scope: r.scope, disabled: false, builtin: false }, Boolean(r.listed), sw);
  });
  if (rows.length === 0) return [];
  const own = await db
    .selectFrom("skills")
    .select(["id", "name", "platform_skill_id", "catalog_item_id"])
    .where("org_id", "=", orgId)
    .where("scope", "=", "org")
    .where("deleted_at", "is", null)
    .where((eb) =>
      eb.or([eb("platform_skill_id", "is", null), eb("pinned_version", "is not", null)]),
    )
    .where("name", "in", [...new Set(rows.map((r) => r.name))])
    .execute();
  const ownByName = new Map(own.map((r) => [r.name, r]));
  const out: SkillVersionRow[] = [];
  const taken = new Map<string, string>();
  rows.sort((a, b) =>
    (a.plugin_name ?? "") < (b.plugin_name ?? "")
      ? -1
      : (a.plugin_name ?? "") > (b.plugin_name ?? "")
        ? 1
        : a.id < b.id
          ? -1
          : 1,
  );
  for (const r of rows) {
    const o = ownByName.get(r.name);
    if (o) {
      const sameComponent =
        o.platform_skill_id === r.id ||
        (o.catalog_item_id !== null && o.catalog_item_id === r.catalog_item_id);
      if (!sameComponent) {
        log?.warn("platform skill shadowed by an org skill of the same name", {
          orgId,
          name: r.name,
          platformSkillId: r.id,
          skillId: o.id,
        });
      }
      continue;
    }
    const first = taken.get(r.name);
    if (first !== undefined) {
      log?.warn("platform skills share a name in one org", {
        orgId,
        name: r.name,
        kept: first,
        dropped: r.id,
      });
      continue;
    }
    taken.set(r.name, r.id);
    out.push({
      id: r.id,
      name: r.name,
      description: r.manifest.description,
      version: r.current_version,
      source: platformSource(r.object_prefix),
      plugin: r.plugin_name,
      origin: "platform",
      platformSkillId: r.id,
      scope: "org",
      agentId: null,
      manifest: r.manifest,
      format: r.source_format,
    });
  }
  return out;
}

/**
 * The org's live skills by id (`ids`; ids that are no usable skill are missing from the map): an
 * agent's own skill or an org skill with its current version; an org copy linked to a platform
 * skill without a pin (ruling B2) as that platform skill's current version under the copy's id,
 * while the platform skill is on in the org; a platform skill id while it is on in the org.
 */
export async function skillVersionsById(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[],
  log?: Pick<Logger, "warn">,
): Promise<Map<string, SkillVersionRow>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, SkillVersionRow>();
  if (unique.length === 0) return out;
  const rows = await db
    .selectFrom("skills as s")
    .innerJoin("skill_versions as v", (j) =>
      j.onRef("v.skill_id", "=", "s.id").onRef("v.version", "=", "s.current_version"),
    )
    .leftJoin("catalog_items as c", "c.id", "s.catalog_item_id")
    .select([
      "s.id",
      "s.scope",
      "s.agent_id",
      "s.name",
      "s.current_version",
      "s.platform_skill_id",
      "s.pinned_version",
      "v.manifest",
      "v.object_prefix",
      "v.source_format",
      "c.name as item_name",
    ])
    .where("s.org_id", "=", orgId)
    .where("s.deleted_at", "is", null)
    .where("s.id", "in", unique)
    .execute();
  const linked = rows.filter(
    (r) => r.scope === "org" && r.platform_skill_id !== null && r.pinned_version === null,
  );
  const known = new Set(rows.map((r) => r.id));
  const platformIds = [
    ...new Set([
      ...unique.filter((id) => !known.has(id)),
      ...linked.map((r) => r.platform_skill_id as string),
    ]),
  ];
  const platform = new Map((await platformOn(db, orgId, platformIds, log)).map((p) => [p.id, p]));
  for (const r of rows) {
    if (linked.includes(r)) {
      const p = platform.get(r.platform_skill_id as string);
      if (p) out.set(r.id, { ...p, id: r.id });
      continue;
    }
    out.set(r.id, {
      id: r.id,
      name: r.name,
      description: r.manifest.description,
      version: r.current_version,
      source: r.object_prefix,
      plugin: r.item_name,
      origin: "org",
      ...(r.platform_skill_id !== null && { platformSkillId: r.platform_skill_id }),
      scope: r.scope,
      agentId: r.agent_id,
      manifest: r.manifest,
      format: r.source_format,
    });
  }
  for (const id of unique) {
    const p = platform.get(id);
    if (p && !known.has(id)) out.set(id, p);
  }
  return out;
}

/**
 * The skills an agent selects, sorted by id: its own skills (`scope = 'agent'`) and the ids of
 * `orgSkills` that resolve ({@link skillVersionsById}: org skills, linked copies, platform skills
 * on in the org). Not deduplicated by name.
 */
export async function selectedSkills(
  db: KernelSchemaDb,
  a: { orgId: string; agentId: string; orgSkills: readonly string[] },
  log?: Pick<Logger, "warn">,
): Promise<SkillVersionRow[]> {
  const agentOwn = await db
    .selectFrom("skills")
    .select("id")
    .where("org_id", "=", a.orgId)
    .where("scope", "=", "agent")
    .where("agent_id", "=", a.agentId)
    .where("deleted_at", "is", null)
    .execute();
  const orgSkills = new Set(a.orgSkills);
  const byId = await skillVersionsById(
    db,
    a.orgId,
    [...agentOwn.map((r) => r.id), ...orgSkills],
    log,
  );
  return [...byId.values()]
    .filter((r) => (r.scope === "agent" ? r.agentId === a.agentId : orgSkills.has(r.id)))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * The org's usable skills, sorted by name: its own live org skills (`scope = 'org'`, unlinked or
 * pinned) and the platform skills on in the org (see {@link platformOn}). An org copy linked
 * without a pin is not listed: its platform skill is. `log` receives the name-clash warnings.
 */
export async function usableSkills(
  db: KernelSchemaDb,
  orgId: string,
  log?: Pick<Logger, "warn">,
): Promise<UsableSkill[]> {
  return (await usableSkillVersions(db, orgId, log)).map(
    ({ scope: _s, agentId: _a, manifest: _m, format: _f, ...u }) => u,
  );
}

/** {@link usableSkills} with each skill's manifest and format. */
export async function usableSkillVersions(
  db: KernelSchemaDb,
  orgId: string,
  log?: Pick<Logger, "warn">,
): Promise<SkillVersionRow[]> {
  const own = await db
    .selectFrom("skills as s")
    .innerJoin("skill_versions as v", (j) =>
      j.onRef("v.skill_id", "=", "s.id").onRef("v.version", "=", "s.current_version"),
    )
    .leftJoin("catalog_items as c", "c.id", "s.catalog_item_id")
    .select([
      "s.id",
      "s.name",
      "s.current_version",
      "s.platform_skill_id",
      "v.manifest",
      "v.object_prefix",
      "v.source_format",
      "c.name as item_name",
    ])
    .where("s.org_id", "=", orgId)
    .where("s.scope", "=", "org")
    .where("s.deleted_at", "is", null)
    .where((eb) =>
      eb.or([eb("s.platform_skill_id", "is", null), eb("s.pinned_version", "is not", null)]),
    )
    .execute();
  const rows: SkillVersionRow[] = own.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.manifest.description,
    version: r.current_version,
    source: r.object_prefix,
    plugin: r.item_name,
    origin: "org",
    ...(r.platform_skill_id !== null && { platformSkillId: r.platform_skill_id }),
    scope: "org",
    agentId: null,
    manifest: r.manifest,
    format: r.source_format,
  }));
  rows.push(...(await platformOn(db, orgId, undefined, log)));
  return rows.sort(byNameThenId);
}
