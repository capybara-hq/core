import { createHash, randomUUID } from "node:crypto";
import {
  type AgentTemplate,
  type Connector,
  type ConnectorTemplateFile,
  type ConnectorTemplateSpec,
  EXTENSION_POINTS,
  type ExtensionManifest,
  type MarketplaceEntry,
  marketplaceEntryDeprecation,
  type PluginManifest,
  parseExtensionPoint,
  parseSkillMd,
  SKILL_ENTRY_FILE,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import semver from "semver";
import { revertTemplateVersionIn, softDeleteTemplateIn } from "../agents/templates.js";
import type { KernelSchemaDb, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import {
  OrgExtensionConfigs,
  type OrgExtensionInput,
  type OrgExtensionPutOptions,
} from "../extensions/org-config.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import type { OrgAction } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import {
  type SkillConflict,
  SkillsService,
  skillConflictError,
  skillConflicts,
} from "../skills/skills.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { CreateConnectorInput } from "../tools/connectors.service.js";
import { ConnectorsService } from "../tools/connectors.service.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import {
  type CatalogVersionFiles,
  findConnectorIn,
  lockOrgForActions,
  readCatalogAgentTemplates,
  readCatalogFiles,
  readCatalogTemplates,
  requiredActions,
  type TemplateDeps,
  templateConnectorInput,
  templatePluginProblem,
} from "./catalog-content.js";
import {
  agentDefinitionRefs,
  componentOn,
  connectorTemplatesOn,
  type DefinitionRefs,
  listedIn,
  loadComponents,
  loadScopeState,
  pluginFactsOf,
  referenceIds,
  switchOf,
} from "./component-state.js";
import {
  assertItemInstallable,
  disabledPluginItems,
  pluginItemDisabled,
  resolveRequestsByInstall,
} from "./request-rules.js";
import { visibleTo } from "./scope.js";
import { ScopeNoLongerWanted, ScopeStillWanted, wantedByScope } from "./scope-state.js";
import { maxSatisfying, satisfiesRange } from "./versions.js";

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
      | "used_by_plugins"
      /** A dependency install still wanted on in the org by its own scope: it stays, standalone. */
      | "wanted_by_scope"
      /**
       * A connector the install created, kept by a scope sync uninstall (the plugin disabled or its
       * scope narrowed, spec §5 rule 8): it stays as the org's own, with its credentials.
       */
      | "org_owned";
  }[];
}

/**
 * What switching a plugin off would do, read without changing anything: its components, the ones the
 * uninstall rules would keep for a reason visible beforehand (a component that pre-existed, or one an
 * agent uses), and the agents that use the plugin's skills, connectors or agent templates.
 */
export interface UninstallPreview {
  installId: string;
  name: string;
  version: string;
  components: { kind: ComponentKind; ref: string; created: boolean }[];
  kept: UninstallReport["kept"];
  agents: { id: string; name: string; uses: { kind: ComponentKind; ref: string }[] }[];
}

/** The confirm hash of an uninstall preview: sha256 over its sorted JSON (the scheme of `diffHash`). */
export function uninstallPreviewHash(p: UninstallPreview): string {
  const by = <T extends { kind: string; ref: string }>(xs: T[]) =>
    [...xs].sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`));
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...p,
        components: by(p.components),
        kept: by(p.kept),
        agents: [...p.agents]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((a) => ({ ...a, uses: by(a.uses) })),
      }),
    )
    .digest("hex");
}

/** Upserts the org's switch row of an item in the caller's transaction (the org lock is held). */
export async function upsertOrgSwitch(
  db: KernelSchemaDb,
  orgId: string,
  itemId: string,
  enabled: boolean,
  actor: string | null,
): Promise<void> {
  await db
    .insertInto("catalog_item_org_switches")
    .values({ item_id: itemId, org_id: orgId, enabled, updated_by: actor })
    .onConflict((oc) =>
      oc.columns(["item_id", "org_id"]).doUpdateSet({
        enabled,
        updated_by: actor,
        updated_at: sql<Date>`now()` as unknown as Date,
      }),
    )
    .execute();
}

/** The kernel (actor null, the scope sync) never installs what needs the org's input. */
export class NeedsOrgInput extends ApiError {
  constructor(readonly plugin: string) {
    super(
      "internal",
      `Plugin ${plugin} needs the organization's input (connector templates); only a person can install it`,
    );
  }
}
const systemNeedsInput = (name: string) => new NeedsOrgInput(name);

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
  /**
   * Always null / false since plugin scope phase 2: a platform plugin has one version for the
   * deployment and the platform update moves every org install (ruling F2); kept for the web until
   * its upgrade dialog goes.
   */
  upgradeAvailable: null;
  deploymentPending: false;
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
  /** Uninstalled by the plugin scope sync: the connectors it created stay as the org's own. */
  via?: "scope";
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
    `Dependency ${name} is disabled by the super admin, so this plugin cannot be installed`,
    [{ dependency: name }],
  );

/**
 * The dependency `d` resolved against the catalog (ruling P2-17, one version per deployment): the
 * dependency's platform version (`platform_synced_version`), which must satisfy its range; only
 * while it has none yet (its first sync failed), the highest imported version satisfying the range
 * that its marketplace does not deprecate, a stable one before a prerelease (the marketplace
 * folding rule). No such item or version -> `catalog.dependency_unresolved`; the item disabled ->
 * `catalog.dependency_disabled` (the super admin's ban is not bypassed, spec §10).
 */
async function resolveOne(
  db: KernelSchemaDb,
  d: { name: string; version: string },
): Promise<ResolvedDependency & { manifest: PluginManifest }> {
  const item = await db
    .selectFrom("catalog_items")
    .select([
      "id",
      "disabled",
      "platform_synced_version",
      "marketplace_id",
      "awaiting_confirmation",
    ])
    .where("name", "=", d.name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!item) {
    throw unresolved(
      d.name,
      d.version,
      "it is not in the platform catalog; ask the super admin to import it",
    );
  }
  if (item.disabled) throw dependencyDisabled(d.name);
  // An org upload waiting for the super admin is no dependency target (ruling P3-9)
  if (item.awaiting_confirmation) {
    throw unresolved(d.name, d.version, "it waits for a super admin to confirm its extension");
  }
  const versions = await db
    .selectFrom("catalog_item_versions")
    .select(["version", "manifest", "imported_at"])
    .where("item_id", "=", item.id)
    .execute();
  let v: (typeof versions)[number] | undefined;
  if (item.platform_synced_version !== null) {
    v = versions.find((x) => x.version === item.platform_synced_version);
    if (!v || !satisfiesRange(v.version, d.version)) {
      throw unresolved(
        d.name,
        d.version,
        `its platform version ${item.platform_synced_version} does not satisfy the range; ask ` +
          "the super admin to update it",
      );
    }
  } else {
    const deprecated = await deprecatedVersions(db, d.name, item.marketplace_id);
    const candidates = versions
      .filter((x) => !deprecated.has(x.version))
      .map((x) => ({ ...x, importedAt: x.imported_at }));
    v =
      maxSatisfying(
        candidates.filter((x) => semver.prerelease(x.version) === null),
        d.version,
      ) ?? maxSatisfying(candidates, d.version);
  }
  if (!v) {
    throw unresolved(
      d.name,
      d.version,
      "no imported version satisfies the range; ask the super admin to import one",
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

/** The versions of plugin `name` its marketplace (`marketplaceId`) marks deprecated. */
async function deprecatedVersions(
  db: KernelSchemaDb,
  name: string,
  marketplaceId: string | null,
): Promise<Set<string>> {
  if (marketplaceId === null) return new Set();
  const rows = await db
    .selectFrom("marketplace_entries")
    .select(["version", "entry"])
    .where("source_id", "=", marketplaceId)
    .where("name", "=", name)
    .execute();
  return new Set(
    rows
      .filter((r) => marketplaceEntryDeprecation(r.entry as MarketplaceEntry) !== null)
      .map((r) => r.version),
  );
}

/**
 * Resolves a plugin's dependencies against the catalog: for each one the platform version of the
 * live item with that name, which must satisfy its range (see `resolveOne`). The whole dependency
 * tree is checked: a dependency nothing satisfies -> `catalog.dependency_unresolved`; a disabled one ->
 * `catalog.dependency_disabled`; a cycle (`a` -> `b` -> `a`, by name) or nesting deeper than
 * {@link DEPENDENCY_DEPTH_LIMIT} -> `catalog.dependency_cycle`. Returns the direct dependencies.
 */
export async function resolveDependencies(
  db: KernelSchemaDb,
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
 * The plugin's skills and agent templates are platform components (plugin scope phase 2): stored
 * once for the deployment and on in the org while the plugin is, so an install writes no org rows
 * for them; a skill name the org already uses (its own skill, another plugin's) refuses the install
 * while planning with `plugin.skill_conflict` (spec §9.2, rule 10). Uninstall leaves the org copies
 * earlier installs wrote (linked to the platform components by the migration).
 * Approval follows the installed plugin's policy only (spec §10): dependency components are
 * re-checked against the root item's policy and their own item's disabled state. Each component is
 * recorded in `plugin_install_components` as soon as it exists; if any step fails, the components
 * this install created (nested dependency installs included) are undone in reverse order, the
 * install is marked failed (error holds only the step and the error code) and 502
 * `plugin.install_failed` is thrown. Uninstall removes only components with created=true that
 * nothing else uses, and reports what it kept and why. No in-process state; the org row lock
 * serializes writes within one org. There is no per-org upgrade: a platform plugin is updated
 * once for the deployment (`PlatformPluginUpdater`, plugin-upgrade.ts, ruling F2); an install left
 * `upgrading` by an earlier per-org upgrade is undone from its journal by the next uninstall. The
 * methods without `private` are internal to the catalog, not an API.
 */
@Injectable()
export class PluginInstaller {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    /** The org row lock (orgs/org-lock.ts): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(StorageService) private readonly storage: StorageService,
    /** The loaded extensions and connectors of this replica (the extension registry). */
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(OrgExtensionConfigs) private readonly orgConfigs: OrgExtensionConfigs,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    /** Org connectors: installs create, upgrade and remove them. */
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The kernel-schema handle of the current context (the transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** `catalog.staleInstallMinutes`: an install `installing` for longer can be cleaned up by uninstalling it. */
  staleInstallMinutes(): number {
    return this.config.get().catalog.staleInstallMinutes;
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
    actor: string | null,
    itemId: string,
    version: string,
    input: PluginInstallInput,
    opts: { actorTokenId?: string; switchOn?: boolean; via?: "scope" } = {},
  ): Promise<PluginInstallView> {
    const { switchOn, via, ...actorOpts } = opts;
    const plan = await this.plan(orgId, actor, itemId, version, input, "", undefined);
    await this.assertNoSkillConflicts(orgId, plan);
    let installId: string;
    try {
      installId = await this.execute(orgId, actor, plan, actorOpts, {
        actions: planActions(plan),
        ...(switchOn === true && { switchOn }),
        ...(via !== undefined && { via }),
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
    const conflicts = await planSkillConflicts(this.db, orgId, plan);
    if (conflicts.length > 0) throw skillConflictError(conflicts);
  }

  /** The connector checks of templates against what this replica loads right now. */
  templateDeps(): TemplateDeps {
    const versions = new Map(this.registry.manifests().map((m) => [m.name, m.version]));
    return {
      findConnector: (plugin, kind) => findConnectorIn(this.registry, plugin, kind),
      pluginVersion: (n) => versions.get(n),
    };
  }

  /**
   * Plans the install of one plugin version and, depth first, of its dependencies not yet
   * installed in the org. `input` null skips the input checks (preflight); dependencies always get
   * an empty input. `at` prefixes validation paths (`dependencies.<name>.` for a dependency);
   * `approvedBy` is the root item for a dependency.
   */
  async plan(
    orgId: string,
    actor: string | null,
    itemId: string,
    version: string,
    input: PluginInstallInput | null,
    at: string,
    approvedBy: string | undefined,
  ): Promise<InstallPlan> {
    if (!UUID_RE.test(itemId)) throw new ApiError("catalog.item_not_found", "Plugin not found");
    const v = await this.db
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
    const declared = await resolveDependencies(this.db, manifest);
    const extension = await this.planExtension(orgId, manifest);
    const allTemplates = await readCatalogTemplates(this.storage, v);
    // Only the connector templates on in the org make connectors (ruling P2-6): one switched off
    // there, outside its own scope or disabled is skipped (input given for it is ignored)
    const on = await connectorTemplatesOn(
      this.db,
      orgId,
      itemId,
      allTemplates.map((t) => t.id),
    );
    const templates = allTemplates.filter((t) => on.has(t.id));
    const deps = [
      ...declared,
      ...(await this.impliedProviders(orgId, manifest, templates, declared)),
    ];
    const skillNames = await catalogSkillNames(this.storage, v, manifest);
    const agentTemplates = await readCatalogAgentTemplates(this.storage, v);
    const connectors = new Map<string, CreateConnectorInput>();
    if (input === null) {
      for (const ct of templates) {
        const problem = templatePluginProblem(this.templateDeps(), ct.file.template);
        if (problem !== undefined) throw new ApiError("catalog.not_deployed", problem);
      }
    } else {
      this.checkInput(manifest, allTemplates, input, at);
      for (const ct of templates) {
        // The kernel installs only what needs no org input (the scope sync's `needs_config` rule)
        if (actor === null) throw systemNeedsInput(manifest.name);
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
      if (await this.liveDependency(this.db, orgId, dep)) {
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
   * The providers of the templates' connector kinds as implied dependencies: a template whose
   * `plugin` is neither this plugin, a declared dependency nor already enabled in the org makes that
   * plugin a dependency (installed first, recorded like a declared one, so an uninstall hands it
   * back). No such plugin offered by the catalog -> `connector.kind_unavailable` naming it, before
   * anything is written.
   */
  async impliedProviders(
    orgId: string,
    manifest: PluginManifest,
    templates: { id: string; file: ConnectorTemplateFile }[],
    declared: { name: string }[],
  ): Promise<ResolvedDependency[]> {
    const out: ResolvedDependency[] = [];
    const seen = new Set<string>([manifest.name, ...declared.map((d) => d.name)]);
    for (const ct of templates) {
      const provider = ct.file.template.plugin;
      if (seen.has(provider)) continue;
      seen.add(provider);
      // Not deployed: the not_deployed refusal of the plan's own checks says it
      if (templatePluginProblem(this.templateDeps(), ct.file.template) !== undefined) continue;
      if (await isExtensionEnabled(this.db, orgId, provider)) continue;
      const refuse = (why: string) =>
        new ApiError(
          "connector.kind_unavailable",
          `Connector template ${ct.id} needs the plugin ${provider}, which is not enabled in this organization: ${why}`,
        );
      let dep: ResolvedDependency;
      try {
        const { manifest: _m, ...resolved } = await resolveOne(this.db, {
          name: provider,
          version: ct.file.template.pluginVersion ?? "*",
        });
        dep = resolved;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        throw refuse(
          e.code === "catalog.dependency_unresolved"
            ? `${provider} is deployed but switched off here and the catalog has no entry to switch it on; ask the super admin to enable it`
            : `${provider} is not offered to this organization`,
        );
      }
      // Scope: only a plugin offered to this org may be switched on for it (nothing more is said)
      const item = await this.db
        .selectFrom("catalog_items")
        .select(["scope", "builtin"])
        .where("id", "=", dep.itemId)
        .executeTakeFirstOrThrow();
      const listed = await this.db
        .selectFrom("catalog_item_scope_orgs")
        .select("item_id")
        .where("item_id", "=", dep.itemId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (!visibleTo({ scope: item.builtin ? "all" : item.scope }, listed !== undefined)) {
        throw refuse(`${provider} is not offered to this organization`);
      }
      if (await this.findLiveDependency(this.db, orgId, dep, false)) {
        throw refuse(`${provider} is installed but switched off in this organization`);
      }
      out.push(dep);
    }
    return out;
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
      this.connectors.checkCreateInput(actor, ci);
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
    db: KernelSchemaDb,
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
    db: KernelSchemaDb,
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
   * `child`, the dependency install this install just created, must still exist. A step of an
   * install or upgrade: it commits on its own (`requires_new`), the undo on failure relies on it.
   */
  @Transactional({ propagation: "requires_new" })
  async recordDependency(
    orgId: string,
    dep: ResolvedDependency,
    record: (c: Component) => Promise<void>,
    child?: string,
  ): Promise<string | undefined> {
    const t = this.db;
    await this.orgLock.lock(orgId);
    const live = await this.findLiveDependency(t, orgId, dep, true);
    if (child !== undefined) {
      if (live?.id !== child || live.status !== "installed") {
        throw unresolved(
          dep.name,
          dep.range,
          "its install in this organization was removed meanwhile; try again",
        );
      }
      await record({ kind: "plugin", ref: child, created: true, skillVersion: null });
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
    await record({ kind: "plugin", ref: live.id, created: false, skillVersion: null });
    return live.id;
  }

  /**
   * Runs a plan: the install row, then the steps (see the class comment). Throws
   * {@link InstallFailure} once the row exists (after rolling back); errors before it propagate
   * as they are. Returns the install id.
   */
  async execute(
    orgId: string,
    actor: string | null,
    plan: InstallPlan,
    opts: { actorTokenId?: string },
    ctx: {
      actions: OrgAction[];
      approvedBy?: string;
      parent?: string;
      switchOn?: boolean;
      /** Installed by the plugin scope sync (recorded in the audits). */
      via?: "scope";
    },
  ): Promise<string> {
    const { itemId, manifest } = plan;
    // The install row (role and item policy re-checked under the lock; one live install per org
    // and item)
    const installId = randomUUID();
    await this.createInstallRow(orgId, actor, plan, ctx, installId);

    const done: Component[] = [];
    // Records a component in the transaction of the context (none: on its own; the install row
    // already cleaned up -> the FK fails, the install aborts and rolls back)
    const record = async (c: Component) => {
      // Into `done` first: a component that exists is rolled back even when recording it fails
      // (enabling an extension and recording it share one transaction and fail together)
      done.push(c);
      await this.db
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
            ...(ctx.via !== undefined && { via: ctx.via }),
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
        await this.enableExtension(
          orgId,
          plan.extension,
          {
            enabled: true,
            ...(plan.extensionConfig !== undefined && { config: plan.extensionConfig }),
          },
          actor,
          opts.actorTokenId,
          { viaItem: itemId, ...(nested && { approvedBy }) },
          record,
        );
      }
      step = "connectors";
      for (const ct of plan.templates) {
        const ci = plan.connectors.get(ct.id);
        if (!ci) throw new ApiError("internal", `Connector template ${ct.id} was not planned`);
        if (actor === null) throw systemNeedsInput(manifest.name);
        const r = await this.connectors.create(orgId, actor, ci, opts.actorTokenId);
        await record({
          kind: "connector",
          ref: r.connector.id,
          created: true,
          skillVersion: null,
          templateId: ct.id,
        });
      }
      // Skills and agent templates are platform components (plugin scope phase 2): stored once for
      // the deployment and on in the org while the plugin is, so the install writes no org rows
      await this.markInstalled(orgId, actor, installId, plan, done, ctx, opts);
      return installId;
    } catch (e) {
      const failure = e instanceof InstallFailure ? e : undefined;
      const code = failure ? failure.code : e instanceof ApiError ? e.code : "internal";
      const rollbackErrors = await this.rollback(orgId, actor, installId, done, opts);
      await this.markFailed(
        orgId,
        actor,
        installId,
        plan,
        ctx,
        { step, code, done, rollbackErrors },
        opts,
      );
      throw new InstallFailure(
        failure ? failure.step : step,
        failure ? failure.cause : e,
        failure ? failure.dependency : [],
        rollbackErrors.length === 0 && (failure?.rolledBack ?? true),
      );
    }
  }

  /**
   * The install row (role and item policy re-checked under the lock; one live install per org and
   * item). A step of the install: committed on its own.
   */
  /**
   * Enables a plugin's extension for the org and records it as a component of the install, in one
   * transaction (`put` joins it): "enabled before" is decided under the org row lock (already
   * enabled: `put` writes nothing, the config is untouched, the component is recorded as not
   * created), and the ledger row is written before the COMMIT, so no concurrent uninstall fits
   * between enabling and recording. Used by the install and the upgrade.
   */
  @Transactional()
  async enableExtension(
    orgId: string,
    name: string,
    input: OrgExtensionInput,
    actor: string | null,
    actorTokenId: string | undefined,
    opts: Pick<OrgExtensionPutOptions, "viaItem" | "approvedBy">,
    record: (c: Component) => Promise<void>,
  ): Promise<void> {
    const ifDisabled = { skipped: false };
    await this.orgConfigs.put(orgId, name, input, actor, actorTokenId, { ...opts, ifDisabled });
    await record({
      kind: "extension",
      ref: name,
      created: !ifDisabled.skipped,
      skillVersion: null,
    });
  }

  @Transactional({ propagation: "requires_new" })
  private async createInstallRow(
    orgId: string,
    actor: string | null,
    plan: InstallPlan,
    ctx: { actions: OrgAction[]; approvedBy?: string; via?: "scope" },
    installId: string,
  ): Promise<void> {
    const { itemId, version } = plan;
    const t = this.db;
    await lockOrgForActions(this.orgLock, orgId, actor, ctx.actions);
    // The scope sync decided outside this lock: a person's switch-off or a scope change committed
    // since then wins (nothing written, converged)
    if (
      ctx.via === "scope" &&
      ctx.approvedBy === undefined &&
      !(await wantedByScope(t, orgId, itemId))
    ) {
      throw new ScopeNoLongerWanted(orgId, itemId);
    }
    if (ctx.approvedBy !== undefined) {
      // A dependency disabled (or removed) since it was planned
      const own = await t
        .selectFrom("catalog_items")
        .select(["disabled", "deleted_at"])
        .where("id", "=", itemId)
        .forShare()
        .executeTakeFirst();
      if (!own || own.deleted_at !== null) {
        throw unresolved(plan.name, plan.version, "it was removed from the platform catalog");
      }
      if (own.disabled) throw dependencyDisabled(plan.name);
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
  }

  /** The install `installed` and its `plugin.org_installed` audit, under the org row lock (its own transaction). */
  @Transactional({ propagation: "requires_new" })
  private async markInstalled(
    orgId: string,
    actor: string | null,
    installId: string,
    plan: InstallPlan,
    done: Component[],
    ctx: { parent?: string; switchOn?: boolean; via?: "scope" },
    opts: { actorTokenId?: string },
  ): Promise<void> {
    const { itemId, version } = plan;
    const t = this.db;
    await this.orgLock.lock(orgId);
    // The platform version current at commit (one per deployment): a platform update that
    // committed while this install ran moved the row already, or did not see it yet
    const updated = await t
      .updateTable("plugin_installs")
      .set((eb) => ({
        status: "installed",
        version: eb.fn.coalesce(
          eb
            .selectFrom("catalog_items as i")
            .select("i.platform_synced_version")
            .where("i.id", "=", itemId),
          eb.ref("plugin_installs.version"),
        ),
      }))
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
    await resolveRequestsByInstall(t, orgId, itemId, actor, opts);
    // The org switch is written with the install, in one transaction under the org lock
    if (ctx.switchOn === true && ctx.parent === undefined) {
      await upsertOrgSwitch(t, orgId, itemId, true, actor);
    }
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
        ...(ctx.via !== undefined && { via: ctx.via }),
      },
    });
  }

  /** The install `failed` with `{ step, code }` and its `plugin.org_install_failed` audit (its own transaction). */
  @Transactional({ propagation: "requires_new" })
  private async markFailed(
    orgId: string,
    actor: string | null,
    installId: string,
    plan: InstallPlan,
    ctx: { parent?: string; via?: "scope" },
    f: { step: Step; code: string; done: Component[]; rollbackErrors: unknown[] },
    opts: { actorTokenId?: string },
  ): Promise<void> {
    const { itemId, version } = plan;
    const { step, code, done, rollbackErrors } = f;
    const t = this.db;
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
        ...(ctx.via !== undefined && { via: ctx.via }),
      },
    });
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
    if (!this.registry.manifests().some((m) => m.name === name)) {
      throw new ApiError(
        "catalog.not_deployed",
        `The extension of plugin ${name} is not deployed; ask the super admin to install and enable it`,
      );
    }
    const enabled = await isExtensionEnabled(this.db, orgId, name);
    if (!enabled && (await disabledPluginItems(this.db, [name])).length > 0) {
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
    actor: string | null,
    installId: string,
    done: Component[],
    opts: { actorTokenId?: string },
  ): Promise<{ kind: ComponentKind; ref: string }[]> {
    const errors: { kind: ComponentKind; ref: string }[] = [];
    for (const c of [...done].reverse()) {
      if (!c.created && c.skillVersion === null) continue;
      try {
        const disabled = await this.rollbackOne(orgId, actor, installId, c, opts);
        for (const p of disabled) await this.orgConfigs.afterDisable(orgId, p);
      } catch (e) {
        errors.push({ kind: c.kind, ref: c.ref });
        this.log.warn("plugin install rollback step failed", {
          orgId,
          kind: c.kind,
          ref: c.ref,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return errors;
  }

  /**
   * Undoes one component of a failed install and deletes its component row, under the org row lock,
   * in a transaction of its own (committed when it returns); returns the extensions it disabled
   * (the caller notifies them).
   */
  @Transactional({ propagation: "requires_new" })
  private async rollbackOne(
    orgId: string,
    actor: string | null,
    installId: string,
    c: Component,
    opts: { actorTokenId?: string },
  ): Promise<string[]> {
    const disabled: string[] = [];
    const t = this.db;
    await this.orgLock.lock(orgId);
    if (c.kind === "plugin") {
      // A dependency install this install created: uninstalled by the usual rules
      const sub: UninstallReport = { removed: [], kept: [] };
      await this.uninstallIn(orgId, actor, c.ref, {
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
        (await this.orgConfigs.enabledDependents(orgId, c.ref)).length > 0
      ) {
        return [];
      }
      const removed = await this.removeComponent(orgId, actor, c, "plugin_install_rollback");
      if (removed && c.kind === "extension") disabled.push(c.ref);
    }
    await t
      .deleteFrom("plugin_install_components")
      .where("install_id", "=", installId)
      .where("kind", "=", c.kind)
      .where("ref", "=", c.ref)
      .execute();
    return disabled;
  }

  /** Removes one component (one already gone is no error); returns whether anything changed. */
  @Transactional({ propagation: "mandatory" })
  async removeComponent(
    orgId: string,
    actor: string | null,
    c: Component,
    reason: string,
  ): Promise<boolean> {
    if (c.kind === "extension") {
      return this.orgConfigs.disableIn(orgId, c.ref, actor, reason);
    }
    const t = this.db;
    if (c.kind === "connector") {
      const live = await t
        .selectFrom("connectors")
        .select("id")
        .where("id", "=", c.ref)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!live) return false;
      await this.connectors.removeIn(orgId, c.ref, actor, undefined, reason);
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
    if (c.created) return this.skills.softDeleteIn(orgId, c.ref, actor, reason);
    if (c.skillVersion !== null) {
      return this.skills.revertVersionIn(orgId, c.ref, c.skillVersion, actor, reason);
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
    actor: string | null,
    installId: string,
    opts: { actorTokenId?: string; via?: "scope" } = {},
    sw?: { expectHash?: string },
  ): Promise<UninstallReport> {
    if (!UUID_RE.test(installId)) throw installNotFound();
    return this.writeUninstall(orgId, actor, installId, opts, sw);
  }

  /**
   * The uninstall's one transaction; the extensions it disabled are notified once it commits. A
   * scope sync uninstall (`via: "scope"`) re-checks under the org row lock that the item is still
   * not wanted in the org and that no other live install depends on it ({@link ScopeStillWanted},
   * nothing written), and keeps the connectors it created as the org's own (`org_owned`).
   */
  @Transactional()
  private async writeUninstall(
    orgId: string,
    actor: string | null,
    installId: string,
    opts: { actorTokenId?: string; via?: "scope" },
    sw?: { expectHash?: string },
  ): Promise<UninstallReport> {
    const { via, ...actorOpts } = opts;
    const report: UninstallReport = { removed: [], kept: [] };
    let itemId: string | undefined;
    if (via === "scope") {
      // A person's switch-on (or a scope change) committed after the sync's decision wins
      await this.orgLock.lock(orgId);
      const row = await this.db
        .selectFrom("plugin_installs")
        .select("item_id")
        .where("id", "=", installId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (
        row !== undefined &&
        ((await wantedByScope(this.db, orgId, row.item_id)) ||
          (await this.heir(orgId, new Set([installId]), "plugin", installId)) !== undefined)
      ) {
        throw new ScopeStillWanted(orgId, row.item_id);
      }
    }
    if (sw !== undefined) {
      // Switching off: the org lock first, then the preview is re-checked and the switch row is
      // written in this same transaction
      await this.orgLock.lock(orgId);
      const row = await this.db
        .selectFrom("plugin_installs")
        .select("item_id")
        .where("id", "=", installId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      itemId = row?.item_id;
      if (sw.expectHash !== undefined && row !== undefined) {
        const now = uninstallPreviewHash(await this.previewUninstall(orgId, installId));
        if (now !== sw.expectHash) {
          throw new ApiError(
            "plugin.switch_stale",
            "The uninstall preview changed; review it and confirm again",
          );
        }
      }
    }
    const outcome = await this.uninstallIn(orgId, actor, installId, {
      report,
      removing: new Set(),
      authorize: true,
      opts: actorOpts,
      ...(via !== undefined && { via }),
    });
    if (outcome === "missing") throw installNotFound();
    if (outcome === "kept") {
      report.kept.push({ kind: "plugin", ref: installId, reason: "used_by_other_install" });
    }
    if (itemId !== undefined && outcome === "removed") {
      await upsertOrgSwitch(this.db, orgId, itemId, false, actor);
    }
    afterCommit(async () => {
      for (const r of report.removed) {
        if (r.kind === "extension") await this.orgConfigs.afterDisable(orgId, r.ref);
      }
    });
    return report;
  }

  /**
   * The oldest other live install (not in `removing`) that has component `kind` / `ref`, or
   * undefined.
   */
  @Transactional({ propagation: "mandatory" })
  async heir(
    orgId: string,
    removing: Set<string>,
    kind: ComponentKind,
    ref: string,
  ): Promise<string | undefined> {
    let q = this.db
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
  @Transactional({ propagation: "mandatory" })
  async handOver(heir: string, kind: ComponentKind, ref: string): Promise<void> {
    await this.db
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
  @Transactional({ propagation: "mandatory" })
  async uninstallIn(
    orgId: string,
    actor: string | null,
    installId: string,
    ctx: UninstallCtx,
  ): Promise<"missing" | "kept" | "removed" | "wanted_by_scope"> {
    const t = this.db;
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
    const staleMinutes = this.staleInstallMinutes();
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
        this.orgLock,
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
    // A dependency its own scope still wants on in the org stays as a standalone install (the
    // dependent's component row goes with the dependent's install row)
    if (ctx.from !== undefined && (await wantedByScope(t, orgId, row.item_id))) {
      return "wanted_by_scope";
    }
    // Another install outside this uninstall depends on it: kept (a dependency uninstall hands
    // ownership over)
    const user = await this.heir(orgId, new Set([...removing, installId]), "plugin", installId);
    if (user !== undefined) {
      if (ctx.from !== undefined) await this.handOver(user, "plugin", installId);
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
    const agentRefs = await this.agentRefs(orgId);
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
      // Skills and agent templates of earlier installs (org copies, now linked to the platform
      // components, phase 2) stay: the plugin's components go off in the org with the install
      if ((c.kind === "skill" || c.kind === "agent_template") && !rollbackMode) continue;
      if (!created) {
        // Rollback cleanup: a version this install added to an existing skill is reverted; other
        // pre-existing components are kept
        if (
          rollbackMode &&
          (c.kind === "skill" || c.kind === "agent_template") &&
          c.skill_version !== null &&
          (await this.removeComponent(orgId, actor, comp, "plugin_install_cleanup"))
        ) {
          addRemoved({ kind: c.kind, ref: c.ref });
          continue;
        }
        keep("pre_existing");
        continue;
      }
      if (c.kind === "plugin") {
        const outcome = await this.uninstallIn(orgId, actor, c.ref, { ...ctx, from: installId });
        if (outcome === "removed") addRemoved({ kind: "plugin", ref: c.ref });
        else if (outcome === "kept") keep("used_by_other_install");
        else if (outcome === "wanted_by_scope") keep("wanted_by_scope");
        continue;
      }
      // A scope sync uninstall leaves the connectors to the org (spec §5 rule 8): the component row
      // goes with the install row, so nothing removes them later
      if (c.kind === "connector" && ctx.via === "scope" && !rollbackMode) {
        keep("org_owned");
        continue;
      }
      const reason = rollbackMode ? "plugin_install_cleanup" : (ctx.reason ?? "plugin_uninstall");
      const outcome = await this.decideRemovalIn(orgId, actor, comp, removing, agentRefs, reason);
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
        ...(ctx.via !== undefined && { via: ctx.via }),
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
  @Transactional({ propagation: "mandatory" })
  async decideRemovalIn(
    orgId: string,
    actor: string | null,
    c: Component,
    removing: Set<string>,
    agentRefs: { connectors: Set<string>; skills: Set<string>; templates: Set<string> },
    reason: string,
  ): Promise<"removed" | "gone" | UninstallReport["kept"][number]["reason"]> {
    if (c.kind === "skill" && agentRefs.skills.has(c.ref)) return "used_by_agents";
    if (c.kind === "agent_template" && agentRefs.templates.has(c.ref)) return "used_by_agents";
    if (c.kind === "connector" && agentRefs.connectors.has(c.ref)) return "used_by_agents";
    if (c.kind !== "connector") {
      const heir = await this.heir(orgId, removing, c.kind, c.ref);
      if (heir !== undefined) {
        await this.handOver(heir, c.kind, c.ref);
        return "used_by_other_install";
      }
    }
    if (c.kind === "extension") {
      const kinds = this.connectorKindsOf(c.ref);
      if (kinds.length > 0) {
        const used = await this.db
          .selectFrom("connectors")
          .select("id")
          .where("org_id", "=", orgId)
          .where("deleted_at", "is", null)
          .where("connector", "in", kinds)
          .executeTakeFirst();
        if (used) return "used_by_connectors";
      }
      if ((await this.orgConfigs.enabledDependents(orgId, c.ref)).length > 0) {
        return "used_by_plugins";
      }
    }
    return (await this.removeComponent(orgId, actor, c, reason)) ? "removed" : "gone";
  }

  /** The order extensions are uninstalled in: the reverse of the install (requires) order; extensions not loaded on this replica last. */
  private uninstallExtensionOrder(refs: string[]): string[] {
    const loaded = new Map(this.registry.manifests().map((m) => [m.name, m]));
    const known = refs.filter((r) => loaded.has(r)).map((r) => loaded.get(r) as ExtensionManifest);
    return [...orderByRequires(known).reverse(), ...refs.filter((r) => !loaded.has(r))];
  }

  /** The org's plugin installs (failed ones included), newest first; `installId` picks one. */
  async list(orgId: string, installId?: string): Promise<PluginInstallView[]> {
    let q = this.db
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
    const comps = await this.db
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
      upgradeAvailable: null,
      deploymentPending: false,
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
  @Transactional({ propagation: "mandatory" })
  async undoUpgradeIn(
    orgId: string,
    actor: string | null,
    installId: string,
    steps: readonly UpgradeStep[],
    reason: string,
  ): Promise<{ kind: ComponentKind; ref: string }[]> {
    const removed: { kind: ComponentKind; ref: string }[] = [];
    const dropRow = (kind: ComponentKind, ref: string) =>
      this.db
        .deleteFrom("plugin_install_components")
        .where("install_id", "=", installId)
        .where("kind", "=", kind)
        .where("ref", "=", ref)
        .execute();
    for (const s of [...steps].reverse()) {
      if (s.op === "skill_version") {
        await this.skills.revertVersionIn(orgId, s.ref, s.version, actor, reason);
        continue;
      }
      if (s.op === "template_version") {
        await revertTemplateVersionIn(this.db, orgId, s.ref, s.version);
        continue;
      }
      if (s.op === "recorded") {
        await dropRow(s.kind, s.ref);
        continue;
      }
      if (s.kind === "plugin") {
        const sub: UninstallReport = { removed: [], kept: [] };
        await dropRow(s.kind, s.ref);
        const outcome = await this.uninstallIn(orgId, actor, s.ref, {
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
        (await this.orgConfigs.enabledDependents(orgId, s.ref)).length > 0
      ) {
        // Another enabled extension needs it: kept, and stays this install's component
        continue;
      }
      const c: Component = { kind: s.kind, ref: s.ref, created: true, skillVersion: null };
      if (await this.removeComponent(orgId, actor, c, reason)) {
        removed.push({ kind: s.kind, ref: s.ref });
      }
      await dropRow(s.kind, s.ref);
    }
    return removed;
  }

  /**
   * Installs the dependencies an installed plugin's version declares and the org lacks (rule 9),
   * as the kernel (actor null): a platform update can add one. Each is recorded on the install
   * as a `plugin` component (created when this installed it, so an uninstall takes it along). One
   * that needs the org's input (connector templates) is left out and its name returned. A
   * dependency already installed in the org is recorded as it is (created false).
   */
  async addMissingDependencies(orgId: string, installId: string): Promise<string[]> {
    const row = await this.db
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_item_versions as v", (j) =>
        j.onRef("v.item_id", "=", "a.item_id").onRef("v.version", "=", "a.version"),
      )
      .select(["a.item_id", "a.status", "v.manifest"])
      .where("a.id", "=", installId)
      .where("a.org_id", "=", orgId)
      .executeTakeFirst();
    if (row?.status !== "installed") return [];
    const record = async (c: Component) => {
      await this.db
        .insertInto("plugin_install_components")
        .values({
          install_id: installId,
          kind: c.kind,
          ref: c.ref,
          created: c.created,
          skill_version: null,
        })
        .onConflict((oc) => oc.columns(["install_id", "kind", "ref"]).doNothing())
        .execute();
    };
    const needsInput: string[] = [];
    for (const dep of await resolveDependencies(this.db, row.manifest as PluginManifest)) {
      if ((await this.recordDependency(orgId, dep, record)) !== undefined) continue;
      let plan: InstallPlan;
      try {
        plan = await this.plan(orgId, null, dep.itemId, dep.version, {}, "", row.item_id);
      } catch (e) {
        if (e instanceof NeedsOrgInput) {
          needsInput.push(dep.name);
          continue;
        }
        throw e;
      }
      const child = await this.execute(
        orgId,
        null,
        plan,
        {},
        {
          actions: requiredActions(plan.manifest),
          approvedBy: row.item_id,
          parent: installId,
          via: "scope",
        },
      );
      await this.recordDependency(orgId, dep, record, child);
    }
    return needsInput;
  }

  /**
   * The connector templates of an installed plugin that are on in the org (ruling P2-6) and have
   * no live connector there: made from the platform template (`platform_template_id`) or recorded
   * on the install (`template_id`). The org's plugin is `needs_config` while any is missing (ruling
   * P2-10). Empty for a plugin not installed.
   */
  async missingConnectors(
    orgId: string,
    itemId: string,
  ): Promise<
    | {
        installId: string;
        version: string;
        templates: { id: string; file: ConnectorTemplateFile }[];
      }
    | undefined
  > {
    const a = await this.db
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_item_versions as v", (j) =>
        j.onRef("v.item_id", "=", "a.item_id").onRef("v.version", "=", "a.version"),
      )
      .select(["a.id", "a.version", "v.manifest", "v.object_prefix", "v.files"])
      .where("a.org_id", "=", orgId)
      .where("a.item_id", "=", itemId)
      .where("a.status", "=", "installed")
      .executeTakeFirst();
    if (!a) return undefined;
    if (((a.manifest as PluginManifest).connectorTemplates ?? []).length === 0) {
      return { installId: a.id, version: a.version, templates: [] };
    }
    const all = await readCatalogTemplates(this.storage, a);
    const on = await connectorTemplatesOn(
      this.db,
      orgId,
      itemId,
      all.map((t) => t.id),
    );
    const made = new Set(
      (
        await this.db
          .selectFrom("connectors as c")
          .innerJoin("platform_connector_templates as p", "p.id", "c.platform_template_id")
          .select("p.template_id")
          .where("c.org_id", "=", orgId)
          .where("c.deleted_at", "is", null)
          .where("p.catalog_item_id", "=", itemId)
          .execute()
      ).map((r) => r.template_id),
    );
    const recorded = await this.db
      .selectFrom("plugin_install_components as l")
      .innerJoin("connectors as c", (j) => j.on(sql<string>`c.id::text`, "=", sql<string>`l.ref`))
      .select("l.template_id")
      .where("l.install_id", "=", a.id)
      .where("l.kind", "=", "connector")
      .where("c.deleted_at", "is", null)
      .execute();
    for (const r of recorded) if (r.template_id !== null) made.add(r.template_id);
    return {
      installId: a.id,
      version: a.version,
      templates: all.filter((t) => on.has(t.id) && !made.has(t.id)),
    };
  }

  /**
   * Creates the connectors an installed plugin is missing (ruling P2-10, `POST …/catalog/:itemId/
   * connectors`): `input.connectors` names some of {@link missingConnectors}' templates with the
   * same input as an install (endpoint, credential or OAuth client); each is created as at install
   * and recorded on the install. Returns the created connectors by template.
   */
  async configureConnectors(
    orgId: string,
    actor: string,
    itemId: string,
    input: PluginInstallInput,
    opts: { actorTokenId?: string } = {},
  ): Promise<{ templateId: string; connectorId: string }[]> {
    if (!UUID_RE.test(itemId)) throw installNotFound();
    const missing = await this.missingConnectors(orgId, itemId);
    if (!missing) throw installNotFound();
    const keys = Object.keys(input.connectors ?? {});
    if (keys.length === 0) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "connectors", message: "Give the input of at least one missing connector" },
      ]);
    }
    for (const k of keys) {
      if (!missing.templates.some((t) => t.id === k)) {
        throw new ApiError("validation_failed", "Request validation failed", [
          {
            path: `connectors.${k}`,
            message: "No connector of this template is missing in this organization",
          },
        ]);
      }
    }
    const item = await this.db
      .selectFrom("catalog_items")
      .select("name")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const plans = missing.templates
      .filter((t) => keys.includes(t.id))
      .map((t) => ({
        id: t.id,
        ci: this.planConnector(
          actor,
          { itemId, version: missing.version, name: item.name },
          t,
          input,
          "",
          undefined,
        ),
      }));
    const out: { templateId: string; connectorId: string }[] = [];
    for (const p of plans) {
      const r = await this.connectors.create(orgId, actor, p.ci, opts.actorTokenId);
      await this.recordConnector(missing.installId, r.connector.id, p.id);
      out.push({ templateId: p.id, connectorId: r.connector.id });
    }
    return out;
  }

  /** A configured connector's ledger row (its own transaction). */
  @Transactional({ propagation: "requires_new" })
  private async recordConnector(installId: string, ref: string, templateId: string): Promise<void> {
    await this.db
      .insertInto("plugin_install_components")
      .values({
        install_id: installId,
        kind: "connector",
        ref,
        created: true,
        skill_version: null,
        template_id: templateId,
      })
      .onConflict((oc) => oc.columns(["install_id", "kind", "ref"]).doNothing())
      .execute();
  }

  /** The connector kinds an extension provides (the `connector@1` implementations loaded on this replica). */
  connectorKindsOf(plugin: string): string[] {
    return this.registry
      .list("connector")
      .filter((e) => e.plugin === plugin)
      .map((e) => (e.impl as Connector | undefined)?.kind)
      .filter((k): k is string => typeof k === "string");
  }

  /**
   * The uninstall preview of an install (see {@link UninstallPreview}); the real uninstall may keep
   * more (another install using a component, a connector still using an extension). The plugin's
   * skills and agent templates are platform components (phase 2): the ones on in the org through
   * the plugin (`follow`) go off with it, so the agents using them (by the platform id or an
   * unpinned org copy linked to it) are listed, also for the dependency installs it created that
   * go with it; ledger rows of earlier installs' org copies are not removed and not listed (an
   * uninstall keeps legacy copies, like the platform update keeps copies of removed components).
   */
  async previewUninstall(orgId: string, installId: string): Promise<UninstallPreview> {
    if (!UUID_RE.test(installId)) throw installNotFound();
    const t = this.db;
    const row = await t
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
      .select(["a.id", "a.item_id", "a.version", "i.name"])
      .where("a.id", "=", installId)
      .where("a.org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) throw installNotFound();
    const ledger = (id: string) =>
      t
        .selectFrom("plugin_install_components")
        .select(["kind", "ref", "created"])
        .where("install_id", "=", id)
        .orderBy("kind")
        .orderBy("ref")
        .execute();
    const comps = (await ledger(installId)).filter(
      (c) => c.kind !== "skill" && c.kind !== "agent_template",
    );
    const agents = await agentDefinitionRefs(t, orgId);
    const used = new Map<
      string,
      { id: string; name: string; uses: { kind: ComponentKind; ref: string }[] }
    >();
    const use = (a: { id: string; name: string }, kind: ComponentKind, ref: string) => {
      const e = used.get(a.id) ?? { id: a.id, name: a.name, uses: [] };
      if (!e.uses.some((u) => u.kind === kind && u.ref === ref)) e.uses.push({ kind, ref });
      used.set(a.id, e);
    };
    const kept: UninstallReport["kept"] = [];
    /**
     * The agents using what goes with an install: connectors it created (they stay, kept for the
     * agents) and the plugin's platform skills and agent templates on in the org through it
     * (`follow`; by the platform id or an unpinned org copy linked to it). Dependency installs it
     * created go with it unless their own scope wants them (Task 7: their components count too).
     */
    const visit = async (
      itemId: string,
      rows: { kind: ComponentKind; ref: string; created: boolean }[],
      top: boolean,
      seen: Set<string>,
    ): Promise<void> => {
      for (const c of rows) {
        if (!c.created) {
          if (top) kept.push({ kind: c.kind, ref: c.ref, reason: "pre_existing" });
          continue;
        }
        if (c.kind === "plugin") {
          const dep = await t
            .selectFrom("plugin_installs")
            .select("item_id")
            .where("id", "=", c.ref)
            .where("org_id", "=", orgId)
            .executeTakeFirst();
          if (!dep) continue;
          if (await wantedByScope(t, orgId, dep.item_id)) {
            if (top) kept.push({ kind: c.kind, ref: c.ref, reason: "wanted_by_scope" });
            continue;
          }
          if (seen.has(c.ref)) continue;
          seen.add(c.ref);
          const sub = (await ledger(c.ref)).filter(
            (x) => x.kind !== "skill" && x.kind !== "agent_template",
          );
          await visit(dep.item_id, sub, false, seen);
          continue;
        }
        if (c.kind !== "connector") continue;
        const users = agents.filter((a) => a.connectors.has(c.ref));
        if (users.length === 0) continue;
        if (top) kept.push({ kind: c.kind, ref: c.ref, reason: "used_by_agents" });
        for (const a of users) use(a, c.kind, c.ref);
      }
      for (const kind of ["skill", "agent_template"] as const) {
        const platform = await loadComponents(t, kind, { itemId });
        const st = await loadScopeState(t, kind, platform);
        const off = platform.filter(
          (c) =>
            c.scopeMode === "follow" &&
            componentOn(
              c,
              pluginFactsOf(st, c.itemId, orgId),
              listedIn(st, c.id, orgId),
              switchOf(st, c.id, orgId),
            ),
        );
        const refs = await referenceIds(
          t,
          orgId,
          kind,
          off.map((c) => c.id),
        );
        for (const a of agents) {
          for (const ref of kind === "skill" ? a.skills : a.templates) {
            if (refs.has(ref)) use(a, kind, ref);
          }
        }
      }
    };
    await visit(row.item_id, comps, true, new Set([installId]));
    return {
      installId,
      name: row.name,
      version: row.version,
      components: comps.map((c) => ({ kind: c.kind, ref: c.ref, created: c.created })),
      kept,
      agents: [...used.values()]
        .map((a) => ({ ...a, uses: a.uses.sort((x, y) => x.ref.localeCompare(y.ref)) }))
        .sort((x, y) => x.id.localeCompare(y.id)),
    };
  }

  /**
   * The connectors, skills (selected, pinned, or in an inline sub-agent template) and agent
   * templates (`subagents.templates`) referenced by the current definitions of the org's live
   * agents.
   */
  async agentRefs(orgId: string): Promise<DefinitionRefs> {
    const out: DefinitionRefs = { connectors: new Set(), skills: new Set(), templates: new Set() };
    for (const a of await agentDefinitionRefs(this.db, orgId)) {
      for (const x of a.connectors) out.connectors.add(x);
      for (const x of a.skills) out.skills.add(x);
      for (const x of a.templates) out.templates.add(x);
    }
    return out;
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
    const parsed = file
      ? parseSkillMd(new TextDecoder().decode(file.data), { invocationKeys: false })
      : undefined;
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
  db: KernelSchemaDb,
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
