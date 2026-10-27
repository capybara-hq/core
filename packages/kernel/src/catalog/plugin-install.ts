import { randomUUID } from "node:crypto";
import {
  type AgentTemplate,
  type Connector,
  type ConnectorTemplateFile,
  type ConnectorTemplateSpec,
  EXTENSION_POINTS,
  type ExtensionManifest,
  type Logger,
  type PluginManifest,
  parseExtensionPoint,
  parseSkillMd,
  SKILL_ENTRY_FILE,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import { normalizeToolRef } from "../agents/definition.js";
import {
  putTemplateVersionIn,
  revertTemplateVersionIn,
  softDeleteTemplateIn,
} from "../agents/templates.js";
import type { KernelDatabase, KernelDb, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { OrgExtensionConfigs } from "../extensions/org-config.js";
import { audit } from "../identity/audit.js";
import { lockOrg } from "../orgs/org-lock.js";
import type { OrgAction } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import {
  type SkillConflict,
  type SkillsService,
  skillConflictError,
  skillConflicts,
} from "../skills/skills.service.js";
import type { StorageService } from "../storage/storage.service.js";
import type { ConnectorsService, CreateConnectorInput } from "../tools/connectors.service.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import {
  type CatalogVersionFiles,
  lockOrgForActions,
  readCatalogAgentTemplates,
  readCatalogFiles,
  readCatalogTemplates,
  requiredActions,
  skillOf,
  type TemplateDeps,
  templateConnectorInput,
  templatePluginProblem,
} from "./org-catalog.service.js";
import {
  assertItemInstallable,
  type CatalogRequestsService,
  disabledPluginItems,
  pluginItemDisabled,
} from "./requests.service.js";
import { upgradeInfo } from "./upgrade-targets.js";
import { maxSatisfying, satisfiesRange } from "./versions.js";

type Trx = Transaction<KernelDatabase>;

/** What an org fills in for one connector template at install (C30). */
export interface ConnectorInstallInput {
  name?: string;
  slug?: string;
  /** Only the paths the template lists in `editableEndpoint`. */
  endpoint?: Record<string, unknown>;
  credential?: Record<string, unknown>;
  client?: { clientId: string; clientSecret?: string };
}

/**
 * What an org fills in when installing a plugin (the body of `POST …/catalog/:itemId/install`
 * without `version`). Dependencies get no input: one whose templates need credentials is installed
 * on its own first.
 */
export interface PluginInstallInput {
  connectors?: Record<string /* templateId */, ConnectorInstallInput>;
  /** The org config of the plugin's extension (used only when this install enables it). */
  extensionConfig?: Record<string, unknown>;
}

/**
 * `plugin` is a dependency install (ref = its plugin install id); `agent_template` (phase C) an
 * agent template (ref = its agent_templates id; like a skill, `skill_version` records the version
 * an install or upgrade added to an existing template).
 */
export type ComponentKind = "extension" | "connector" | "skill" | "plugin" | "agent_template";

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

/** A plugin install in an org (`GET /orgs/:orgId/plugin-installs`). */
export interface PluginInstallView {
  id: string;
  itemId: string;
  name: string;
  version: string;
  status: "installing" | "installed" | "failed" | "uninstalling" | "upgrading";
  installedBy: string | null;
  installedAt: string;
  /** The failed install's step and code, or the last failed upgrade's (the install stays installed). */
  error: { step: string; code: string } | null;
  /**
   * `dropped`: an upgrade removed it from the plugin but kept it because an agent uses it ("no
   * longer in the plugin"); uninstalling still removes it once nothing uses it.
   */
  components: {
    kind: ComponentKind;
    ref: string;
    created: boolean;
    skillVersion: number | null;
    dropped: boolean;
  }[];
  /** The highest version this install can be upgraded to now, null when none (spec §10). */
  upgradeAvailable: string | null;
  /**
   * The plugin's extension on the deployment is not the one of this install's version: the org
   * should upgrade to the deployment's version ("upgrade pending", Decision 10).
   */
  deploymentPending: boolean;
}

export interface PluginInstallerDeps {
  db: KernelDb;
  storage: StorageService;
  host: Pick<ExtensionHost, "manifests" | "list">;
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  connectors: Pick<
    ConnectorsService,
    "create" | "removeIn" | "checkCreateInput" | "prepareTemplateUpdate" | "applyTemplateIn"
  >;
  skills: Pick<SkillsService, "createVersionFromFiles" | "softDeleteIn" | "revertVersionIn">;
  orgConfigs: Pick<OrgExtensionConfigs, "put" | "disableIn" | "afterDisable" | "enabledDependents">;
  requests: Pick<CatalogRequestsService, "resolveByInstall">;
  /** `catalog.staleInstallMinutes`: an install `installing` for longer can be cleaned up by uninstalling it. */
  staleInstallMinutes: () => number;
  log?: Pick<Logger, "warn">;
}

/** A dependency resolved against the catalog. */
export interface ResolvedDependency {
  name: string;
  range: string;
  itemId: string;
  version: string;
}

/** How deep plugin dependencies may nest (the root plugin's dependencies are level 1). */
export const DEPENDENCY_DEPTH_LIMIT = 10;

/** A component as an install records it (see `plugin_install_components`). */
export interface Component {
  kind: ComponentKind;
  ref: string;
  created: boolean;
  /** A skill's or agent template's version this install added to an existing one. */
  skillVersion: number | null;
  /** A connector's template id (written to `template_id`, migration 0049). */
  templateId?: string;
}

export type Step = "dependencies" | "extension" | "connectors" | "skills" | "agent_templates";

/** What one plugin install will do, checked before anything is written. */
export interface InstallPlan {
  itemId: string;
  name: string;
  version: string;
  manifest: PluginManifest;
  row: CatalogVersionFiles;
  /** The version's source format, recorded on the org skill versions it creates. */
  sourceFormat: SourceFormat;
  /** The plugin's own extension, to enable in the org. */
  extension: string | null;
  extensionConfig: Record<string, unknown> | undefined;
  templates: { id: string; file: ConnectorTemplateFile }[];
  /** The connector inputs built from the templates (empty for a preflight without input). */
  connectors: Map<string, CreateConnectorInput>;
  /** The names of the plugin's skills (from each SKILL.md). */
  skillNames: string[];
  /** The plugin's agent templates (phase C). */
  agentTemplates: { path: string; template: AgentTemplate }[];
  /** `plan` null: the dependency was already installed in the org when planned. */
  dependencies: { dep: ResolvedDependency; plan: InstallPlan | null }[];
}

/** A failed install step, carried up through the dependency installs to the root install. */
export class InstallFailure extends Error {
  constructor(
    readonly step: Step,
    readonly cause: unknown,
    /** The dependency path when a dependency failed (outermost first). */
    readonly dependency: string[],
    readonly rolledBack: boolean,
  ) {
    super("plugin install failed");
  }

  get code(): string {
    return this.cause instanceof ApiError ? this.cause.code : "internal";
  }
}

export interface UninstallCtx {
  report: UninstallReport;
  /** The installs this uninstall is removing (none of them counts as still using a component). */
  removing: Set<string>;
  /** The install whose `plugin` component led here (a dependency uninstall). */
  from?: string;
  /** Re-check the actor's org actions (false for a rollback). */
  authorize: boolean;
  reason?: string;
  opts: { actorTokenId?: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_ACTIONS: OrgAction[] = [
  "org.extensions.manage",
  "connectors.manage",
  "skills.manage",
  "agents.manage",
];
const installNotFound = () => new ApiError("plugin.install_not_found", "Plugin install not found");
const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);
const isUniqueViolation = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

const unresolved = (name: string, range: string, why: string) =>
  new ApiError(
    "catalog.dependency_unresolved",
    `Dependency ${name}@${range} cannot be resolved: ${why}`,
    [{ dependency: name, range }],
  );

const dependencyDisabled = (name: string) =>
  new ApiError(
    "catalog.dependency_disabled",
    `Dependency ${name} is disabled by the enterprise admin, so this plugin cannot be installed`,
    [{ dependency: name }],
  );

/**
 * The dependency `d` resolved against the catalog: the highest imported version (of the live item
 * with that name) satisfying its range. No such item or version -> `catalog.dependency_unresolved`;
 * the item disabled -> `catalog.dependency_disabled` (the enterprise admin's ban is not bypassed,
 * spec §10).
 */
async function resolveOne(
  db: KernelDb | Trx,
  d: { name: string; version: string },
): Promise<ResolvedDependency & { manifest: PluginManifest }> {
  const item = await db
    .selectFrom("catalog_items")
    .select(["id", "policy"])
    .where("name", "=", d.name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!item) {
    throw unresolved(
      d.name,
      d.version,
      "it is not in the enterprise catalog; ask the enterprise admin to import it",
    );
  }
  if (item.policy === "disabled") throw dependencyDisabled(d.name);
  const versions = await db
    .selectFrom("catalog_item_versions")
    .select(["version", "manifest", "imported_at"])
    .where("item_id", "=", item.id)
    .execute();
  const v = maxSatisfying(
    versions.map((x) => ({ ...x, importedAt: x.imported_at })),
    d.version,
  );
  if (!v) {
    throw unresolved(
      d.name,
      d.version,
      "no imported version satisfies the range; ask the enterprise admin to import one",
    );
  }
  return {
    name: d.name,
    range: d.version,
    itemId: item.id,
    version: v.version,
    manifest: v.manifest as PluginManifest,
  };
}

/**
 * Resolves a plugin's dependencies against the catalog: for each one the highest imported version
 * of the live item with that name satisfying its range. The whole dependency tree is checked: a
 * dependency nothing satisfies -> `catalog.dependency_unresolved`; a disabled one ->
 * `catalog.dependency_disabled`; a cycle (`a` -> `b` -> `a`, by name) or nesting deeper than
 * {@link DEPENDENCY_DEPTH_LIMIT} -> `catalog.dependency_cycle`. Returns the direct dependencies.
 */
export async function resolveDependencies(
  db: KernelDb | Trx,
  manifest: PluginManifest,
): Promise<ResolvedDependency[]> {
  // Explored subtrees by name@version: their height and the names in them (a memo hit whose names
  // meet the current path is a cycle)
  const memo = new Map<string, { height: number; names: Set<string> }>();
  const direct: ResolvedDependency[] = [];
  const tooDeep = () =>
    new ApiError(
      "catalog.dependency_cycle",
      `Plugin dependencies nest more than ${DEPENDENCY_DEPTH_LIMIT} levels deep`,
    );
  const cycle = (path: string[], name: string) =>
    new ApiError(
      "catalog.dependency_cycle",
      `Plugin dependencies form a cycle: ${[...path.slice(path.indexOf(name)), name].join(" -> ")}`,
      [{ cycle: [...path.slice(path.indexOf(name)), name] }],
    );
  const visit = async (
    m: PluginManifest,
    path: string[],
  ): Promise<{ height: number; names: Set<string> }> => {
    let height = 0;
    const names = new Set<string>();
    for (const d of m.dependencies ?? []) {
      if (path.includes(d.name)) throw cycle(path, d.name);
      if (path.length > DEPENDENCY_DEPTH_LIMIT) throw tooDeep();
      const r = await resolveOne(db, d);
      if (path.length === 1) {
        direct.push({ name: r.name, range: r.range, itemId: r.itemId, version: r.version });
      }
      const key = `${r.name}@${r.version}`;
      let sub = memo.get(key);
      if (sub) {
        const hit = path.find((p) => sub?.names.has(p));
        if (hit !== undefined) throw cycle(path, hit);
      } else {
        sub = await visit(r.manifest, [...path, d.name]);
        memo.set(key, sub);
      }
      if (path.length + sub.height > DEPENDENCY_DEPTH_LIMIT) throw tooDeep();
      height = Math.max(height, sub.height + 1);
      names.add(d.name);
      for (const n of sub.names) names.add(n);
    }
    return { height, names };
  };
  await visit(manifest, [manifest.name]);
  return direct;
}

/**
 * The input a template needs that the org did not give: a static credential (the org's for an
 * org-owned template; for a personal one the installer's own, stored as their personal credential,
 * since creating the connector lists its tools with it), or the OAuth client of a
 * client-credentials / manual-client template. Undefined when nothing is missing.
 * `personalCredential: false` keeps a personal static template optional (an existing connector
 * whose template's auth changed: its members keep giving their own).
 */
export function missingTemplateInput(
  template: ConnectorTemplateSpec,
  given: ConnectorInstallInput | undefined,
  o: { personalCredential?: boolean } = {},
): "credential" | "client" | undefined {
  const auth = template.auth as unknown as ConnectorAuth;
  if (auth.type === "oauth_client" || (auth.type === "oauth_code" && auth.client === "manual")) {
    return given?.client === undefined ? "client" : undefined;
  }
  if (auth.type === "none" || auth.type === "oauth_code") return undefined;
  if (auth.ownership !== "org" && o.personalCredential === false) return undefined;
  return given?.credential === undefined ? "credential" : undefined;
}

/** `e` with its validation paths under `at` (input errors of a template's connector). */
export function under(e: unknown, at: string): unknown {
  if (!(e instanceof ApiError) || e.code !== "validation_failed" || !Array.isArray(e.details)) {
    return e;
  }
  return new ApiError(
    e.code,
    e.message,
    e.details.map((d) =>
      typeof d === "object" && d !== null && typeof (d as { path?: unknown }).path === "string"
        ? { ...d, path: [at, (d as { path: string }).path].filter(Boolean).join(".") }
        : d,
    ),
  );
}

/**
 * Org install and uninstall of plugins (spec §10, C31). Before anything is written the install is
 * planned for the whole dependency tree ({@link resolveDependencies}; the extension deployed, the
 * template input valid, else a 4xx). Install, in order, per plugin:
 * 1. dependencies, depth first: each one not yet installed in the org gets its own nested
 *    `plugin_installs` row, recorded as a `plugin` component of the parent (created=true); one
 *    already installed is recorded created=false;
 * 2. the plugin's extension, enabled in the org (`catalog.not_deployed` when the deployment does
 *    not run it; already enabled is recorded created=false);
 * 3. connectors from the templates (credentials / clients go to secrets, default policies are
 *    recorded `policy_source 'template'`);
 * 4. the skills (an org skill of the same name from the same catalog item gets a new version,
 *    recorded created=false with skill_version; one of other provenance, the org's own or another
 *    item's, refuses the install while planning with `plugin.skill_conflict`, spec §9.2).
 * Approval follows the installed plugin's policy only (spec §10): dependency components are
 * re-checked against the root item's policy and their own item's disabled state. Each component is
 * recorded in `plugin_install_components` as soon as it exists; if any step fails, the components
 * this install created (nested dependency installs included) are undone in reverse order, the
 * install is marked failed (error holds only the step and the error code) and 502
 * `plugin.install_failed` is thrown. Uninstall removes only components with created=true that
 * nothing else uses, and reports what it kept and why. No in-process state; the org row lock
 * serializes writes within one org. In-place upgrades are run by `PluginUpgrader`
 * (plugin-upgrade.ts), which reuses the planning, install and ledger methods here (the ones without
 * `private` are internal to the catalog, not an API).
 */
export class PluginInstaller {
  constructor(private readonly d: PluginInstallerDeps) {}

  /** The installer's dependencies (shared with `PluginUpgrader`). */
  get deps(): PluginInstallerDeps {
    return this.d;
  }

  /**
   * The checks an install runs before it creates anything, without the org's input (for the org
   * catalog to run before a request is created): dependency resolution, the extensions deployed and
   * the template connectors available. Returns the org actions the whole install needs.
   */
  async preflight(
    orgId: string,
    actor: string,
    itemId: string,
    version: string,
  ): Promise<{ actions: OrgAction[] }> {
    const plan = await this.plan(orgId, actor, itemId, version, null, "", undefined);
    await this.assertNoSkillConflicts(orgId, plan);
    return { actions: planActions(plan) };
  }

  async install(
    orgId: string,
    actor: string,
    itemId: string,
    version: string,
    input: PluginInstallInput,
    opts: { actorTokenId?: string } = {},
  ): Promise<PluginInstallView> {
    const plan = await this.plan(orgId, actor, itemId, version, input, "", undefined);
    await this.assertNoSkillConflicts(orgId, plan);
    let installId: string;
    try {
      installId = await this.execute(orgId, actor, plan, opts, {
        actions: planActions(plan),
      });
    } catch (e) {
      if (!(e instanceof InstallFailure)) throw e;
      // A dependency another install is still installing: retryable, a 409 as it is
      if (e.cause instanceof ApiError && e.cause.code === "plugin.install_in_progress") {
        throw e.cause;
      }
      const dep = e.dependency.length > 0 ? ` in dependency ${e.dependency.join(" > ")}` : "";
      throw new ApiError(
        "plugin.install_failed",
        `Installing the plugin failed at step ${e.step}${dep} (${e.code}); the components it created were removed`,
        [
          {
            step: e.step,
            code: e.code,
            ...(e.dependency.length > 0 && { dependency: e.dependency.join(" > ") }),
            ...(e.cause instanceof ApiError && { message: e.cause.message }),
            ...(e.cause instanceof ApiError &&
              e.cause.details !== undefined && { causeDetails: e.cause.details }),
            rolledBack: e.rolledBack,
          },
        ],
      );
    }
    const [view] = await this.list(orgId, installId);
    if (!view) throw installNotFound();
    return view;
  }

  /**
   * Refuses a plan whose skills would overwrite a skill of other provenance (spec §9.2, Decision
   * 8) with 409 `plugin.skill_conflict`, before anything is written: for the plugin and each
   * dependency it installs, an org skill of the same name that is the org's own or another item's,
   * and a name two plugins of the same plan both bring (the one installed first is the source).
   */
  private async assertNoSkillConflicts(orgId: string, plan: InstallPlan): Promise<void> {
    const conflicts = await planSkillConflicts(this.d.db, orgId, plan);
    if (conflicts.length > 0) throw skillConflictError(conflicts);
  }

  /** The connector checks of templates against what this replica loads right now. */
  templateDeps(): TemplateDeps {
    const versions = new Map(this.d.host.manifests().map((m) => [m.name, m.version]));
    return { findConnector: this.d.findConnector, pluginVersion: (n) => versions.get(n) };
  }

  /**
   * Plans the install of one plugin version and, depth first, of its dependencies not yet
   * installed in the org. `input` null skips the input checks (preflight); dependencies always get
   * an empty input. `at` prefixes validation paths (`dependencies.<name>.` for a dependency);
   * `approvedBy` is the root item for a dependency.
   */
  async plan(
    orgId: string,
    actor: string,
    itemId: string,
    version: string,
    input: PluginInstallInput | null,
    at: string,
    approvedBy: string | undefined,
  ): Promise<InstallPlan> {
    if (!UUID_RE.test(itemId)) throw new ApiError("catalog.item_not_found", "Plugin not found");
    const v = await this.d.db
      .selectFrom("catalog_item_versions as v")
      .innerJoin("catalog_items as i", "i.id", "v.item_id")
      .select([
        "i.name",
        "v.manifest",
        "v.object_prefix",
        "v.files",
        "v.version",
        "v.source_format",
      ])
      .where("v.item_id", "=", itemId)
      .where("v.version", "=", version)
      .where("i.deleted_at", "is", null)
      .executeTakeFirst();
    if (!v) throw new ApiError("catalog.item_not_found", "Plugin version not found");
    const manifest = v.manifest as PluginManifest;
    const deps = await resolveDependencies(this.d.db, manifest);
    const extension = await this.planExtension(orgId, manifest);
    const templates = await readCatalogTemplates(this.d.storage, v);
    const skillNames = await catalogSkillNames(this.d.storage, v, manifest);
    const agentTemplates = await readCatalogAgentTemplates(this.d.storage, v);
    const connectors = new Map<string, CreateConnectorInput>();
    if (input === null) {
      for (const ct of templates) {
        const problem = templatePluginProblem(this.templateDeps(), ct.file.template);
        if (problem !== undefined) throw new ApiError("catalog.not_deployed", problem);
      }
    } else {
      this.checkInput(manifest, templates, input, at);
      for (const ct of templates) {
        connectors.set(
          ct.id,
          this.planConnector(
            actor,
            { itemId, version, name: manifest.name },
            ct,
            input,
            at,
            approvedBy,
          ),
        );
      }
    }
    const dependencies: InstallPlan["dependencies"] = [];
    for (const dep of deps) {
      if (await this.liveDependency(this.d.db, orgId, dep)) {
        dependencies.push({ dep, plan: null });
        continue;
      }
      dependencies.push({
        dep,
        plan: await this.plan(
          orgId,
          actor,
          dep.itemId,
          dep.version,
          input === null ? null : {},
          `${at}dependencies.${dep.name}.`,
          approvedBy ?? itemId,
        ),
      });
    }
    return {
      itemId,
      name: v.name,
      version,
      manifest,
      row: v,
      sourceFormat: v.source_format,
      extension,
      extensionConfig: input?.extensionConfig,
      templates,
      connectors,
      skillNames,
      agentTemplates,
      dependencies,
    };
  }

  /**
   * The connector input of one template from the org's input (C30), checked without a connection:
   * the template's connector extension deployed, the input valid, the credential / OAuth client it
   * needs given (else 400; a dependency's says to install it on its own first).
   */
  planConnector(
    actor: string,
    plugin: { itemId: string; version: string; name: string },
    ct: { id: string; file: ConnectorTemplateFile },
    input: PluginInstallInput,
    at: string,
    approvedBy: string | undefined,
  ): CreateConnectorInput {
    const path = `${at}connectors.${ct.id}`;
    const given = input.connectors?.[ct.id];
    const ci = templateConnectorInput(
      this.templateDeps(),
      ct.file.template,
      {
        itemId: plugin.itemId,
        version: plugin.version,
        templateId: ct.id,
        ...(approvedBy !== undefined && { approvedBy }),
      },
      given,
      ct.file.displayName.en,
      path,
    );
    const missing = missingTemplateInput(ct.file.template, given);
    if (missing !== undefined) {
      const personal =
        missing === "credential" &&
        (ct.file.template.auth as unknown as { ownership?: string }).ownership !== "org";
      const needs =
        missing === "client"
          ? "an OAuth client"
          : personal
            ? "the installer's own credential"
            : "an org credential";
      throw fail(
        `${path}.${missing}`,
        approvedBy !== undefined
          ? `Dependency ${plugin.name} has a connector template that needs ${needs}; install ${plugin.name} on its own first`
          : personal
            ? "This connector template uses each member's own credential; give yours (it lists the tools and is stored as your personal credential)"
            : `This connector template needs ${needs}`,
      );
    }
    try {
      this.d.connectors.checkCreateInput(actor, ci);
    } catch (e) {
      throw under(e, path);
    }
    return ci;
  }

  /**
   * The org's live install of a dependency's item (installing or installed), or undefined. One at a
   * version outside the dependency's range -> `catalog.dependency_unresolved` (org upgrades arrive in
   * phase A).
   */
  async liveDependency(
    db: KernelDb | Trx,
    orgId: string,
    dep: ResolvedDependency,
  ): Promise<string | undefined> {
    const live = await this.findLiveDependency(db, orgId, dep, false);
    if (!live) return undefined;
    if (!satisfiesRange(live.version, dep.range)) {
      throw unresolved(
        dep.name,
        dep.range,
        `this organization has version ${live.version} installed; uninstall it to install a matching version`,
      );
    }
    return live.id;
  }

  /**
   * The org's live (not failed) install of a dependency's item; `lock` takes it FOR SHARE (the
   * caller holds the org row lock).
   */
  private async findLiveDependency(
    db: KernelDb | Trx,
    orgId: string,
    dep: ResolvedDependency,
    lock: boolean,
  ): Promise<{ id: string; version: string; status: string } | undefined> {
    let q = db
      .selectFrom("plugin_installs")
      .select(["id", "version", "status"])
      .where("org_id", "=", orgId)
      .where("item_id", "=", dep.itemId)
      .where("status", "<>", "failed");
    if (lock) q = q.forShare();
    return q.executeTakeFirst();
  }

  /**
   * Records an install of `dep` as a `plugin` component of the install, checked and written in one
   * transaction under the org row lock, so a concurrent uninstall or a sibling install's rollback
   * cannot leave the component pointing at a removed install. `created` false: the org's existing
   * install, if any (returns its id, undefined when there is none); it must be `installed`
   * (`installing` -> 409 `plugin.install_in_progress`, retry later) and in range. `created` true:
   * `child`, the dependency install this install just created, must still exist.
   */
  async recordDependency(
    orgId: string,
    dep: ResolvedDependency,
    record: (c: Component, t: Trx) => Promise<void>,
    child?: string,
  ): Promise<string | undefined> {
    return this.d.db.transaction().execute(async (t) => {
      await lockOrg(t, orgId);
      const live = await this.findLiveDependency(t, orgId, dep, true);
      if (child !== undefined) {
        if (live?.id !== child || live.status !== "installed") {
          throw unresolved(
            dep.name,
            dep.range,
            "its install in this organization was removed meanwhile; try again",
          );
        }
        await record({ kind: "plugin", ref: child, created: true, skillVersion: null }, t);
        return child;
      }
      if (!live) return undefined;
      if (!satisfiesRange(live.version, dep.range)) {
        throw unresolved(
          dep.name,
          dep.range,
          `this organization has version ${live.version} installed; uninstall it to install a matching version`,
        );
      }
      if (live.status !== "installed") {
        throw new ApiError(
          "plugin.install_in_progress",
          `Dependency ${dep.name} is being installed by another install in this organization; try again when it finishes. An install stuck for longer than catalog.staleInstallMinutes can be removed by uninstalling it`,
        );
      }
      await record({ kind: "plugin", ref: live.id, created: false, skillVersion: null }, t);
      return live.id;
    });
  }

  /**
   * Runs a plan: the install row, then the steps (see the class comment). Throws
   * {@link InstallFailure} once the row exists (after rolling back); errors before it propagate
   * as they are. Returns the install id.
   */
  async execute(
    orgId: string,
    actor: string,
    plan: InstallPlan,
    opts: { actorTokenId?: string },
    ctx: { actions: OrgAction[]; approvedBy?: string; parent?: string },
  ): Promise<string> {
    const { itemId, version, manifest } = plan;
    // The install row (role and item policy re-checked under the lock; one live install per org
    // and item)
    const installId = randomUUID();
    await this.d.db.transaction().execute(async (t) => {
      await lockOrgForActions(t, orgId, actor, ctx.actions);
      if (ctx.approvedBy !== undefined) {
        // A dependency disabled (or removed) since it was planned
        const own = await t
          .selectFrom("catalog_items")
          .select(["policy", "deleted_at"])
          .where("id", "=", itemId)
          .forShare()
          .executeTakeFirst();
        if (!own || own.deleted_at !== null) {
          throw unresolved(plan.name, plan.version, "it was removed from the enterprise catalog");
        }
        if (own.policy === "disabled") throw dependencyDisabled(plan.name);
      }
      await assertItemInstallable(t, orgId, itemId, ctx.approvedBy ?? itemId);
      const live = await t
        .selectFrom("plugin_installs")
        .select("id")
        .where("org_id", "=", orgId)
        .where("item_id", "=", itemId)
        .where("status", "<>", "failed")
        .executeTakeFirst();
      if (live) throw alreadyInstalled();
      try {
        await t
          .insertInto("plugin_installs")
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
    // Records a component in the given transaction (the install row already cleaned up -> the FK
    // fails, the install aborts and rolls back)
    const record = async (c: Component, t?: Trx) => {
      // Into `done` first: a component that exists is rolled back even when recording it fails
      // (enabling an extension and recording it share one transaction and fail together)
      done.push(c);
      await (t ?? this.d.db)
        .insertInto("plugin_install_components")
        .values({
          install_id: installId,
          kind: c.kind,
          ref: c.ref,
          created: c.created,
          skill_version: c.skillVersion,
          template_id: c.templateId ?? null,
        })
        .onConflict((oc) => oc.columns(["install_id", "kind", "ref"]).doNothing())
        .execute();
    };
    const approvedBy = ctx.approvedBy ?? itemId;
    const nested = ctx.approvedBy !== undefined;
    let step: Step = "dependencies";
    try {
      for (const { dep, plan: depPlan } of plan.dependencies) {
        // Installed already (before, or by an earlier dependency): recorded, not reinstalled
        if ((await this.recordDependency(orgId, dep, record)) !== undefined) continue;
        if (depPlan === null) {
          throw unresolved(
            dep.name,
            dep.range,
            "its install in this organization was removed meanwhile; try again",
          );
        }
        let child: string;
        try {
          child = await this.execute(orgId, actor, depPlan, opts, {
            actions: requiredActions(depPlan.manifest),
            approvedBy,
            parent: installId,
          });
        } catch (e) {
          if (e instanceof InstallFailure) {
            throw new InstallFailure(e.step, e.cause, [dep.name, ...e.dependency], e.rolledBack);
          }
          // Another install created it meanwhile: use that one
          if (
            e instanceof ApiError &&
            e.code === "plugin.already_installed" &&
            (await this.recordDependency(orgId, dep, record)) !== undefined
          ) {
            continue;
          }
          throw new InstallFailure("dependencies", e, [dep.name], true);
        }
        await this.recordDependency(orgId, dep, record, child);
      }
      step = "extension";
      if (plan.extension !== null) {
        const p = plan.extension;
        // "Enabled before" is decided under the org row lock (already enabled: put writes nothing,
        // the config is untouched); the component is recorded in the same transaction
        await this.d.orgConfigs.put(
          orgId,
          p,
          {
            enabled: true,
            ...(plan.extensionConfig !== undefined && { config: plan.extensionConfig }),
          },
          actor,
          opts.actorTokenId,
          {
            viaItem: itemId,
            ...(nested && { approvedBy }),
            ifDisabled: { skipped: false },
            inTransaction: (t, skipped) =>
              record({ kind: "extension", ref: p, created: !skipped, skillVersion: null }, t),
          },
        );
      }
      step = "connectors";
      for (const ct of plan.templates) {
        const ci = plan.connectors.get(ct.id);
        if (!ci) throw new ApiError("internal", `Connector template ${ct.id} was not planned`);
        const r = await this.d.connectors.create(orgId, actor, ci, opts.actorTokenId);
        await record({
          kind: "connector",
          ref: r.connector.id,
          created: true,
          skillVersion: null,
          templateId: ct.id,
        });
      }
      step = "agent_templates";
      for (const a of plan.agentTemplates) {
        // Created (or a new version of the org's live template of this plugin and name) and
        // recorded in one transaction, under the org row lock
        await this.d.db.transaction().execute(async (t) => {
          await lockOrg(t, orgId);
          const r = await putTemplateVersionIn(
            t,
            {
              orgId,
              plugin: plan.name,
              catalogItemId: itemId,
              catalogVersion: version,
              sourceFormat: plan.sourceFormat,
            },
            a.template,
          );
          await record(
            {
              kind: "agent_template",
              ref: r.id,
              created: r.created,
              skillVersion: !r.created && r.changed ? r.version : null,
            },
            t,
          );
        });
      }
      step = "skills";
      for (const s of manifest.skills ?? []) {
        const files = await readCatalogFiles(
          this.d.storage,
          plan.row.object_prefix,
          plan.row.files,
          packagePath(s.path),
        );
        const r = await this.d.skills.createVersionFromFiles(
          orgId,
          actor,
          { ...skillOf(files), files },
          {
            catalog: {
              itemId,
              version,
              ...(nested && { approvedBy }),
              format: plan.sourceFormat,
              suggestPinned: s.pinned === true,
            },
            ...opts,
          },
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
          .updateTable("plugin_installs")
          .set({ status: "installed" })
          .where("id", "=", installId)
          .where("status", "=", "installing")
          .executeTakeFirst();
        // The install row was already cleaned up as stale: do not audit plugin.org_installed, roll
        // back
        if (updated.numUpdatedRows === 0n) {
          throw new ApiError(
            "plugin.install_not_found",
            "The install record was cleaned up as stale while the install was running",
          );
        }
        await this.d.requests.resolveByInstall(t, orgId, itemId, actor, opts);
        await audit(t, {
          actorAccountId: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          orgId,
          action: "plugin.org_installed",
          target: installId,
          detail: {
            itemId,
            name: plan.name,
            version,
            components: done,
            ...(ctx.parent !== undefined && { dependencyOf: ctx.parent }),
          },
        });
      });
      return installId;
    } catch (e) {
      const failure = e instanceof InstallFailure ? e : undefined;
      const code = failure ? failure.code : e instanceof ApiError ? e.code : "internal";
      const rollbackErrors = await this.rollback(orgId, actor, installId, done, opts);
      await this.d.db.transaction().execute(async (t) => {
        await t
          .updateTable("plugin_installs")
          .set({ status: "failed", error: JSON.stringify({ step, code }) })
          .where("id", "=", installId)
          .execute();
        await audit(t, {
          actorAccountId: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          orgId,
          action: "plugin.org_install_failed",
          target: installId,
          detail: {
            itemId,
            name: plan.name,
            version,
            step,
            code,
            rolledBack: done,
            rollbackErrors,
            ...(ctx.parent !== undefined && { dependencyOf: ctx.parent }),
          },
        });
      });
      throw new InstallFailure(
        failure ? failure.step : step,
        failure ? failure.cause : e,
        failure ? failure.dependency : [],
        rollbackErrors.length === 0 && (failure?.rolledBack ?? true),
      );
    }
  }

  /**
   * The extension to enable: the plugin's own, when it has one. Not loaded on this replica ->
   * `catalog.not_deployed`; not yet enabled in this org while its own catalog item is disabled ->
   * `catalog.item_disabled` (a disabled item is a master switch, Ruling M-5); already enabled is
   * unaffected.
   */
  async planExtension(orgId: string, manifest: PluginManifest): Promise<string | null> {
    if (!manifest.extension) return null;
    const name = manifest.name;
    if (!this.d.host.manifests().some((m) => m.name === name)) {
      throw new ApiError(
        "catalog.not_deployed",
        `The extension of plugin ${name} is not deployed; ask the enterprise admin to install and enable it`,
      );
    }
    const enabled = await isExtensionEnabled(this.d.db, orgId, name);
    if (!enabled && (await disabledPluginItems(this.d.db, [name])).length > 0) {
      throw pluginItemDisabled([name]);
    }
    return name;
  }

  /** The input only names the plugin's template ids, and an extension config needs an extension. */
  private checkInput(
    manifest: PluginManifest,
    templates: { id: string }[],
    input: PluginInstallInput,
    at: string,
  ): void {
    const ids = new Set(templates.map((c) => c.id));
    for (const k of Object.keys(input.connectors ?? {})) {
      if (!ids.has(k))
        throw fail(`${at}connectors.${k}`, "No such connector template in this plugin");
    }
    if (input.extensionConfig !== undefined && !manifest.extension) {
      throw fail(`${at}extensionConfig`, "This plugin has no extension");
    }
  }

  /**
   * Undoes the components this install created, in reverse order (the role is not re-checked: it
   * undoes this install's own changes); returns the ones that failed. The component rows of undone
   * (or already gone) components are deleted in the same transaction, so cleaning up the failed
   * install later only handles what failed to undo or was kept, and does not undo again an extension
   * an org admin re-enabled by hand or a skill version a user uploaded since.
   */
  private async rollback(
    orgId: string,
    actor: string,
    installId: string,
    done: Component[],
    opts: { actorTokenId?: string },
  ): Promise<{ kind: ComponentKind; ref: string }[]> {
    const errors: { kind: ComponentKind; ref: string }[] = [];
    for (const c of [...done].reverse()) {
      if (!c.created && c.skillVersion === null) continue;
      try {
        const disabled: string[] = [];
        await this.d.db.transaction().execute(async (t) => {
          await lockOrg(t, orgId);
          if (c.kind === "plugin") {
            // A dependency install this install created: uninstalled by the usual rules
            const sub: UninstallReport = { removed: [], kept: [] };
            await this.uninstallIn(t, orgId, actor, c.ref, {
              report: sub,
              removing: new Set([installId]),
              from: installId,
              authorize: false,
              reason: "plugin_install_rollback",
              opts,
            });
            disabled.push(...sub.removed.filter((r) => r.kind === "extension").map((r) => r.ref));
          } else {
            // Another enabled extension depends on it (only it provides what that one needs in this
            // org): kept (its component row too), so the other does not lose its dependency
            if (
              c.kind === "extension" &&
              (await this.d.orgConfigs.enabledDependents(t, orgId, c.ref)).length > 0
            ) {
              return;
            }
            const removed = await this.removeComponent(
              t,
              orgId,
              actor,
              c,
              "plugin_install_rollback",
            );
            if (removed && c.kind === "extension") disabled.push(c.ref);
          }
          await t
            .deleteFrom("plugin_install_components")
            .where("install_id", "=", installId)
            .where("kind", "=", c.kind)
            .where("ref", "=", c.ref)
            .execute();
        });
        for (const p of disabled) await this.d.orgConfigs.afterDisable(orgId, p);
      } catch (e) {
        errors.push({ kind: c.kind, ref: c.ref });
        this.d.log?.warn("plugin install rollback step failed", {
          orgId,
          kind: c.kind,
          ref: c.ref,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return errors;
  }

  /** Removes one component (one already gone is no error); returns whether anything changed. */
  async removeComponent(
    t: Trx,
    orgId: string,
    actor: string,
    c: Component,
    reason: string,
  ): Promise<boolean> {
    if (c.kind === "extension") {
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
    if (c.kind === "plugin") return false;
    if (c.kind === "agent_template") {
      if (c.created) return softDeleteTemplateIn(t, orgId, c.ref);
      if (c.skillVersion !== null) {
        return revertTemplateVersionIn(t, orgId, c.ref, c.skillVersion);
      }
      return false;
    }
    if (c.created) return this.d.skills.softDeleteIn(t, orgId, c.ref, actor, reason);
    if (c.skillVersion !== null) {
      return this.d.skills.revertVersionIn(t, orgId, c.ref, c.skillVersion, actor, reason);
    }
    return false;
  }

  /**
   * Uninstall (the plugin's component actions, see `requiredActions`, re-checked under the org row
   * lock, one transaction). Removes only components with created=true:
   * - a skill is kept when an agent selects it (used_by_agents) or another plugin install in this
   *   org uses it too (used_by_other_install);
   * - a connector is kept when an agent references it (used_by_agents);
   * - an extension is kept when another plugin install uses it too (used_by_other_install), a
   *   connector still uses a connector it provides (used_by_connectors), or another enabled
   *   extension depends on it (used_by_plugins);
   * - a dependency install (`plugin`) is uninstalled by these same rules, after the plugin's own
   *   components; it is kept when another install outside this uninstall depends on it
   *   (used_by_other_install);
   * - components that existed before are kept (pre_existing).
   * When kept for used_by_other_install, ownership passes to the oldest remaining install (its
   * component row becomes created=true), so the uninstall order doesn't change the end result.
   * Uninstalling a dependency another install still uses removes nothing and reports it kept
   * (`plugin`, used_by_other_install). Deletes the install rows and audits `plugin.org_uninstalled`
   * per install (detail has removed / kept). Can be uninstalled: installed; failed (already rolled
   * back: clears the row and leftovers); installing for longer than `catalog.staleInstallMinutes`
   * (a replica crashed midway) - the last two are cleaned up as a rollback (versions added to
   * existing skills are reverted too). Still installing -> `plugin.install_in_progress`.
   */
  async uninstall(
    orgId: string,
    actor: string,
    installId: string,
    opts: { actorTokenId?: string } = {},
  ): Promise<UninstallReport> {
    if (!UUID_RE.test(installId)) throw installNotFound();
    const report: UninstallReport = { removed: [], kept: [] };
    await this.d.db.transaction().execute(async (t) => {
      const outcome = await this.uninstallIn(t, orgId, actor, installId, {
        report,
        removing: new Set(),
        authorize: true,
        opts,
      });
      if (outcome === "missing") throw installNotFound();
      if (outcome === "kept") {
        report.kept.push({ kind: "plugin", ref: installId, reason: "used_by_other_install" });
      }
    });
    for (const r of report.removed) {
      if (r.kind === "extension") await this.d.orgConfigs.afterDisable(orgId, r.ref);
    }
    return report;
  }

  /**
   * The oldest other live install (not in `removing`) that has component `kind` / `ref`, or
   * undefined.
   */
  async heir(
    t: Trx,
    orgId: string,
    removing: Set<string>,
    kind: ComponentKind,
    ref: string,
  ): Promise<string | undefined> {
    let q = t
      .selectFrom("plugin_install_components as c")
      .innerJoin("plugin_installs as a", "a.id", "c.install_id")
      .select("a.id")
      .where("a.org_id", "=", orgId)
      .where("a.status", "in", ["installing", "installed", "upgrading"])
      .where("c.kind", "=", kind)
      .where("c.ref", "=", ref);
    if (removing.size > 0) q = q.where("a.id", "not in", [...removing]);
    const row = await q.orderBy("a.installed_at").orderBy("a.id").executeTakeFirst();
    return row?.id;
  }

  /** Passes ownership of a component to `heir` (its component row becomes created=true). */
  async handOver(t: Trx, heir: string, kind: ComponentKind, ref: string): Promise<void> {
    await t
      .updateTable("plugin_install_components")
      .set({ created: true })
      .where("install_id", "=", heir)
      .where("kind", "=", kind)
      .where("ref", "=", ref)
      .execute();
  }

  /**
   * Uninstalls one install in the caller's transaction (see {@link uninstall}); dependency installs
   * it created recurse. Its own components' outcomes go into `ctx.report` (and its audit); the
   * outcome of the install itself is returned for the caller to report: `missing`, `kept` (another
   * install outside this uninstall depends on it) or `removed`.
   */
  async uninstallIn(
    t: Trx,
    orgId: string,
    actor: string,
    installId: string,
    ctx: UninstallCtx,
  ): Promise<"missing" | "kept" | "removed"> {
    const { removing } = ctx;
    if (removing.has(installId)) return "removed";
    // This install's own slice of the report (its audit), also appended to the shared report
    const mine: UninstallReport = { removed: [], kept: [] };
    const addRemoved = (x: UninstallReport["removed"][number]) => {
      mine.removed.push(x);
      ctx.report.removed.push(x);
    };
    const addKept = (x: UninstallReport["kept"][number]) => {
      mine.kept.push(x);
      ctx.report.kept.push(x);
    };
    const staleMinutes = this.d.staleInstallMinutes();
    if (ctx.authorize) {
      const target = await t
        .selectFrom("plugin_installs as a")
        .innerJoin("catalog_item_versions as v", (j) =>
          j.onRef("v.item_id", "=", "a.item_id").onRef("v.version", "=", "a.version"),
        )
        .select("v.manifest")
        .where("a.id", "=", installId)
        .where("a.org_id", "=", orgId)
        .executeTakeFirst();
      await lockOrgForActions(
        t,
        orgId,
        actor,
        target ? requiredActions(target.manifest as PluginManifest) : ALL_ACTIONS,
      );
    }
    const row = await t
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
      .select([
        "a.id",
        "a.item_id",
        "a.version",
        "a.status",
        "i.name",
        sql<boolean>`a.installed_at < now() - make_interval(mins => ${staleMinutes})`.as("stale"),
        sql<boolean>`coalesce((a.upgrade->>'startedAt')::timestamptz < now() - make_interval(mins => ${staleMinutes}), false)`.as(
          "upgradeStale",
        ),
        "a.upgrade",
      ])
      .where("a.id", "=", installId)
      .where("a.org_id", "=", orgId)
      .forUpdate("a")
      .executeTakeFirst();
    if (!row) return "missing";
    // Another install outside this uninstall depends on it: kept (a dependency uninstall hands
    // ownership over)
    const user = await this.heir(t, orgId, new Set([...removing, installId]), "plugin", installId);
    if (user !== undefined) {
      if (ctx.from !== undefined) await this.handOver(t, user, "plugin", installId);
      return "kept";
    }
    if (
      row.status === "uninstalling" ||
      (row.status === "installing" && !row.stale) ||
      (row.status === "upgrading" && !row.upgradeStale)
    ) {
      throw new ApiError(
        "plugin.install_in_progress",
        `This plugin install is still in progress; it can be cleaned up after ${staleMinutes} minutes`,
      );
    }
    if (row.status === "upgrading") {
      // An upgrade interrupted midway (a replica crashed): undone first, back at the old version
      const undone = await this.undoUpgradeIn(
        t,
        orgId,
        actor,
        installId,
        journalEntries(row.upgrade),
        "plugin_upgrade_cleanup",
      );
      for (const x of undone) addRemoved(x);
    }
    removing.add(installId);
    // failed (already rolled back) and a stale installing (a replica crashed midway) are cleaned up
    // as a rollback
    const rollbackMode = row.status !== "installed" && row.status !== "upgrading";
    const comps = await t
      .selectFrom("plugin_install_components")
      .select(["kind", "ref", "created", "skill_version"])
      .where("install_id", "=", installId)
      .orderBy("kind")
      .orderBy("ref")
      .execute();
    // Skills and agent templates -> connectors -> extensions (in reverse requires order: dependents before providers)
    // -> dependency installs (created ones first)
    const extensionOrder = this.uninstallExtensionOrder(
      comps.filter((c) => c.kind === "extension").map((c) => c.ref),
    );
    const rank = (c: { kind: ComponentKind; ref: string; created: boolean }) =>
      c.kind === "skill" || c.kind === "agent_template"
        ? 0
        : c.kind === "connector"
          ? 1
          : c.kind === "extension"
            ? 2 + extensionOrder.indexOf(c.ref)
            : 1000 + (c.created ? 0 : 1);
    comps.sort((a, b) => rank(a) - rank(b));
    const agentRefs = await this.agentRefs(t, orgId);
    for (const c of comps) {
      const keep = (reason: UninstallReport["kept"][number]["reason"]) =>
        addKept({ kind: c.kind, ref: c.ref, reason });
      let created = c.created;
      if (c.kind === "plugin") {
        // Re-read: an earlier dependency uninstall may have handed it over, or removed it
        const now = await t
          .selectFrom("plugin_install_components")
          .select("created")
          .where("install_id", "=", installId)
          .where("kind", "=", "plugin")
          .where("ref", "=", c.ref)
          .executeTakeFirst();
        const live = await t
          .selectFrom("plugin_installs")
          .select("id")
          .where("id", "=", c.ref)
          .where("org_id", "=", orgId)
          .executeTakeFirst();
        if (!now || !live) continue;
        created = now.created;
      }
      const comp: Component = { kind: c.kind, ref: c.ref, created, skillVersion: c.skill_version };
      if (!created) {
        // Rollback cleanup: a version this install added to an existing skill is reverted; other
        // pre-existing components are kept
        if (
          rollbackMode &&
          (c.kind === "skill" || c.kind === "agent_template") &&
          c.skill_version !== null &&
          (await this.removeComponent(t, orgId, actor, comp, "plugin_install_cleanup"))
        ) {
          addRemoved({ kind: c.kind, ref: c.ref });
          continue;
        }
        keep("pre_existing");
        continue;
      }
      if (c.kind === "plugin") {
        const outcome = await this.uninstallIn(t, orgId, actor, c.ref, { ...ctx, from: installId });
        if (outcome === "removed") addRemoved({ kind: "plugin", ref: c.ref });
        else if (outcome === "kept") keep("used_by_other_install");
        continue;
      }
      const reason = rollbackMode ? "plugin_install_cleanup" : (ctx.reason ?? "plugin_uninstall");
      const outcome = await this.decideRemovalIn(
        t,
        orgId,
        actor,
        comp,
        removing,
        agentRefs,
        reason,
      );
      if (outcome === "removed") addRemoved({ kind: c.kind, ref: c.ref });
      else if (outcome !== "gone") keep(outcome);
    }
    await t.deleteFrom("plugin_installs").where("id", "=", installId).execute();
    await audit(t, {
      actorAccountId: actor,
      ...(ctx.opts.actorTokenId !== undefined && { actorTokenId: ctx.opts.actorTokenId }),
      orgId,
      action: "plugin.org_uninstalled",
      target: installId,
      detail: {
        itemId: row.item_id,
        name: row.name,
        version: row.version,
        status: row.status,
        removed: mine.removed,
        kept: mine.kept,
        ...(ctx.from !== undefined && { dependencyOf: ctx.from }),
      },
    });
    return "removed";
  }

  /**
   * The uninstall rules for one component an install created (a skill, connector or extension;
   * dependency installs recurse through {@link uninstallIn}), in the caller's transaction: kept
   * when an agent uses the skill / connector (`used_by_agents`), when another live install outside
   * `removing` has it (`used_by_other_install`, ownership handed over to the oldest one, so the
   * uninstall order doesn't change the result), when a connector still uses the extension's
   * connector kind (`used_by_connectors`) or another enabled extension depends on it
   * (`used_by_plugins`); otherwise removed (`removed`, or `gone` when it no longer existed). Used
   * by uninstall and by an upgrade's removals.
   */
  async decideRemovalIn(
    t: Trx,
    orgId: string,
    actor: string,
    c: Component,
    removing: Set<string>,
    agentRefs: { connectors: Set<string>; skills: Set<string>; templates: Set<string> },
    reason: string,
  ): Promise<"removed" | "gone" | UninstallReport["kept"][number]["reason"]> {
    if (c.kind === "skill" && agentRefs.skills.has(c.ref)) return "used_by_agents";
    if (c.kind === "agent_template" && agentRefs.templates.has(c.ref)) return "used_by_agents";
    if (c.kind === "connector" && agentRefs.connectors.has(c.ref)) return "used_by_agents";
    if (c.kind !== "connector") {
      const heir = await this.heir(t, orgId, removing, c.kind, c.ref);
      if (heir !== undefined) {
        await this.handOver(t, heir, c.kind, c.ref);
        return "used_by_other_install";
      }
    }
    if (c.kind === "extension") {
      const kinds = this.connectorKindsOf(c.ref);
      if (kinds.length > 0) {
        const used = await t
          .selectFrom("connectors")
          .select("id")
          .where("org_id", "=", orgId)
          .where("deleted_at", "is", null)
          .where("connector", "in", kinds)
          .executeTakeFirst();
        if (used) return "used_by_connectors";
      }
      if ((await this.d.orgConfigs.enabledDependents(t, orgId, c.ref)).length > 0) {
        return "used_by_plugins";
      }
    }
    return (await this.removeComponent(t, orgId, actor, c, reason)) ? "removed" : "gone";
  }

  /** The order extensions are uninstalled in: the reverse of the install (requires) order; extensions not loaded on this replica last. */
  private uninstallExtensionOrder(refs: string[]): string[] {
    const loaded = new Map(this.d.host.manifests().map((m) => [m.name, m]));
    const known = refs.filter((r) => loaded.has(r)).map((r) => loaded.get(r) as ExtensionManifest);
    return [...orderByRequires(known).reverse(), ...refs.filter((r) => !loaded.has(r))];
  }

  /** The org's plugin installs (failed ones included), newest first; `installId` picks one. */
  async list(orgId: string, installId?: string): Promise<PluginInstallView[]> {
    let q = this.d.db
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
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
      .where("a.org_id", "=", orgId);
    if (installId !== undefined) q = q.where("a.id", "=", installId);
    const rows = await q.orderBy("a.installed_at", "desc").orderBy("a.id").execute();
    if (rows.length === 0) return [];
    const info = await upgradeInfo(
      this.d.db,
      this.d.host,
      rows.map((r) => ({ itemId: r.item_id, name: r.name, version: r.version })),
    );
    const comps = await this.d.db
      .selectFrom("plugin_install_components")
      .select(["install_id", "kind", "ref", "created", "skill_version", "dropped"])
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
      error: (r.error as PluginInstallView["error"]) ?? null,
      components: comps
        .filter((c) => c.install_id === r.id)
        .map((c) => ({
          kind: c.kind,
          ref: c.ref,
          created: c.created,
          skillVersion: c.skill_version,
          dropped: c.dropped,
        })),
      upgradeAvailable: info.get(`${r.item_id}@${r.version}`)?.upgradeAvailable ?? null,
      deploymentPending: info.get(`${r.item_id}@${r.version}`)?.deploymentPending ?? false,
    }));
  }

  /**
   * Undoes the steps of an upgrade in the caller's transaction (the caller holds the org row lock),
   * in reverse order: components it created are removed (a dependency install by the uninstall
   * rules, an extension another enabled extension depends on is kept), the ledger rows it added
   * are deleted, and versions it added to skills are reverted (`revertVersionIn` reverts exactly
   * one version, and an upgrade adds at most one per skill). Returns the components removed (an
   * extension among them needs `afterDisable` once committed). Used when an upgrade fails and when
   * an interrupted one is cleaned up.
   */
  async undoUpgradeIn(
    t: Trx,
    orgId: string,
    actor: string,
    installId: string,
    steps: readonly UpgradeStep[],
    reason: string,
  ): Promise<{ kind: ComponentKind; ref: string }[]> {
    const removed: { kind: ComponentKind; ref: string }[] = [];
    const dropRow = (kind: ComponentKind, ref: string) =>
      t
        .deleteFrom("plugin_install_components")
        .where("install_id", "=", installId)
        .where("kind", "=", kind)
        .where("ref", "=", ref)
        .execute();
    for (const s of [...steps].reverse()) {
      if (s.op === "skill_version") {
        await this.d.skills.revertVersionIn(t, orgId, s.ref, s.version, actor, reason);
        continue;
      }
      if (s.op === "template_version") {
        await revertTemplateVersionIn(t, orgId, s.ref, s.version);
        continue;
      }
      if (s.op === "recorded") {
        await dropRow(s.kind, s.ref);
        continue;
      }
      if (s.kind === "plugin") {
        const sub: UninstallReport = { removed: [], kept: [] };
        await dropRow(s.kind, s.ref);
        const outcome = await this.uninstallIn(t, orgId, actor, s.ref, {
          report: sub,
          removing: new Set([installId]),
          from: installId,
          authorize: false,
          reason,
          opts: {},
        });
        removed.push(...sub.removed.filter((r) => r.kind === "extension"));
        if (outcome === "removed") removed.push({ kind: "plugin", ref: s.ref });
        continue;
      }
      if (
        s.kind === "extension" &&
        (await this.d.orgConfigs.enabledDependents(t, orgId, s.ref)).length > 0
      ) {
        // Another enabled extension needs it: kept, and stays this install's component
        continue;
      }
      const c: Component = { kind: s.kind, ref: s.ref, created: true, skillVersion: null };
      if (await this.removeComponent(t, orgId, actor, c, reason)) {
        removed.push({ kind: s.kind, ref: s.ref });
      }
      await dropRow(s.kind, s.ref);
    }
    return removed;
  }

  /** The connector kinds an extension provides (the `connector@1` implementations loaded on this replica). */
  connectorKindsOf(plugin: string): string[] {
    return this.d.host
      .list("connector")
      .filter((e) => e.plugin === plugin)
      .map((e) => (e.impl as Connector | undefined)?.kind)
      .filter((k): k is string => typeof k === "string");
  }

  /**
   * The connectors, org skills and agent templates (`subagents.templates`) referenced by the
   * current definitions of the org's live agents.
   */
  async agentRefs(
    t: Trx,
    orgId: string,
  ): Promise<{ connectors: Set<string>; skills: Set<string>; templates: Set<string> }> {
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
    const templates = new Set<string>();
    for (const r of rows) {
      const def = r.definition as {
        tools?: unknown[];
        skills?: { orgSkills?: unknown[] };
        subagents?: { templates?: unknown[] };
      } | null;
      for (const ref of def?.tools ?? []) {
        const n = normalizeToolRef(ref) as { kind?: unknown; connectorId?: unknown };
        if (n?.kind === "connector" && typeof n.connectorId === "string") {
          connectors.add(n.connectorId);
        }
      }
      for (const s of def?.skills?.orgSkills ?? []) if (typeof s === "string") skills.add(s);
      for (const x of def?.subagents?.templates ?? []) if (typeof x === "string") templates.add(x);
    }
    return { connectors, skills, templates };
  }
}

/**
 * The skill names of a catalog version, read from each skill's SKILL.md in storage (the names are
 * not in plugin.json). Used by install planning and the upgrade preview.
 */
export async function catalogSkillNames(
  storage: StorageService,
  row: CatalogVersionFiles,
  manifest: PluginManifest,
): Promise<string[]> {
  const out: string[] = [];
  for (const s of manifest.skills ?? []) {
    const dir = packagePath(s.path);
    const entry = `${dir}/${SKILL_ENTRY_FILE}`;
    const files = await readCatalogFiles(
      storage,
      row.object_prefix,
      row.files.filter((f) => f.path === entry),
      dir,
    );
    const file = files[0];
    const parsed = file ? parseSkillMd(new TextDecoder().decode(file.data)) : undefined;
    if (!parsed || "errors" in parsed) {
      throw new ApiError("internal", `Stored skill ${dir} has no valid ${SKILL_ENTRY_FILE}`);
    }
    out.push(parsed.name);
  }
  return out;
}

/** The parts of an {@link InstallPlan} the skill conflict check reads (an upgrade builds one too). */
export interface SkillPlan {
  itemId: string;
  name: string;
  version: string;
  skillNames: string[];
  dependencies: { plan: SkillPlan | null }[];
}

/**
 * The skill conflicts of a plan, depth first in install order (dependencies before the plugin).
 * Exported for the upgrade preview.
 */
export async function planSkillConflicts(
  db: KernelDb | Trx,
  orgId: string,
  plan: SkillPlan,
): Promise<SkillConflict[]> {
  const out: SkillConflict[] = [];
  const seen = new Set<string>();
  /** Skill name -> the plugin of this plan that brings it first. */
  const planned = new Map<string, { itemId: string; name: string; version: string }>();
  const visit = async (p: SkillPlan): Promise<void> => {
    for (const d of p.dependencies) if (d.plan) await visit(d.plan);
    for (const c of await skillConflicts(db, orgId, p.itemId, p.skillNames)) {
      if (!seen.has(c.skill)) out.push(c);
      seen.add(c.skill);
    }
    for (const skill of p.skillNames) {
      const first = planned.get(skill);
      if (first === undefined) planned.set(skill, p);
      else if (first.itemId !== p.itemId && !seen.has(skill)) {
        out.push({ skill, source: { kind: "plugin", name: first.name, version: first.version } });
        seen.add(skill);
      }
    }
  };
  await visit(plan);
  return out;
}

/**
 * One step a running upgrade took, journaled in `plugin_installs.upgrade.done` (migration 0049) so
 * a failed or interrupted upgrade can be undone: `created` a component the upgrade created (its
 * ledger row created=true), `recorded` an existing component it added to the ledger
 * (created=false), `skill_version` / `template_version` a version it added to a skill / an agent
 * template.
 */
export type UpgradeStep =
  | { op: "created"; kind: ComponentKind; ref: string }
  | { op: "recorded"; kind: ComponentKind; ref: string }
  | { op: "skill_version"; ref: string; version: number }
  | { op: "template_version"; ref: string; version: number };

const COMPONENT_KINDS = new Set<string>([
  "extension",
  "connector",
  "skill",
  "plugin",
  "agent_template",
]);

/** The journaled steps of `plugin_installs.upgrade` (malformed entries are skipped). */
export function journalEntries(upgrade: unknown): UpgradeStep[] {
  const done = (upgrade as { done?: unknown } | null)?.done;
  if (!Array.isArray(done)) return [];
  const out: UpgradeStep[] = [];
  for (const e of done as Record<string, unknown>[]) {
    if (typeof e !== "object" || e === null || typeof e.ref !== "string") continue;
    if (
      (e.op === "skill_version" || e.op === "template_version") &&
      typeof e.version === "number"
    ) {
      out.push({ op: e.op, ref: e.ref, version: e.version });
    } else if (
      (e.op === "created" || e.op === "recorded") &&
      typeof e.kind === "string" &&
      COMPONENT_KINDS.has(e.kind)
    ) {
      out.push({ op: e.op, kind: e.kind as ComponentKind, ref: e.ref });
    }
  }
  return out;
}

/** The org actions a plan needs: the union over the plugins it installs (spec §10). */
export function planActions(plan: InstallPlan): OrgAction[] {
  const out = new Set<OrgAction>(requiredActions(plan.manifest));
  for (const d of plan.dependencies) {
    if (d.plan) for (const a of planActions(d.plan)) out.add(a);
  }
  return [...out];
}

const alreadyInstalled = () =>
  new ApiError(
    "plugin.already_installed",
    "This plugin is already installed in this organization; uninstall it before installing again",
  );

/**
 * Orders extensions by `requires`: when an org-scoped capability an extension needs is provided by
 * another extension in the set, the provider comes first; a cycle keeps the given order.
 */
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
