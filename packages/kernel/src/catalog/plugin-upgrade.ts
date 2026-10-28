import { createHash, randomUUID } from "node:crypto";
import type { AgentTemplate, ConnectorTemplateFile, PluginManifest } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import { putTemplateVersionIn } from "../agents/templates.js";
import type { KernelDatabase, KernelSchemaDb, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { audit } from "../identity/audit.js";
import type { OrgAction } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import { skillConflictError } from "../skills/skills.service.js";
import type {
  CreateConnectorInput,
  PreparedTemplateUpdate,
  TemplateUpdateInput,
} from "../tools/connectors.service.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import { canonicalJson } from "../tools/registry.js";
import {
  type CatalogVersionFiles,
  getPath,
  lockOrgForActions,
  type OrgCatalogTemplate,
  orgTemplateView,
  readCatalogAgentTemplates,
  readCatalogFiles,
  readCatalogTemplates,
  requiredActions,
  setPath,
  skillOf,
  templatePluginProblem,
} from "./org-catalog.service.js";
import {
  type ComponentKind,
  catalogSkillNames,
  InstallFailure,
  type InstallPlan,
  journalEntries,
  missingTemplateInput,
  type PluginInstaller,
  type PluginInstallerDeps,
  type PluginInstallInput,
  type PluginInstallView,
  planActions,
  planSkillConflicts,
  type ResolvedDependency,
  resolveDependencies,
  type UninstallReport,
  type UpgradeStep,
  under,
} from "./plugin-install.js";
import { assertItemInstallable } from "./requests.service.js";
import { deployedExtension, deploymentTarget } from "./upgrade-targets.js";
import { satisfiesRange } from "./versions.js";

type Trx = Transaction<KernelDatabase>;

/** How a component differs between the installed and the target version. */
export type UpgradeChange = "added" | "changed" | "removed" | "unchanged";

/**
 * One component of an upgrade preview: `ref` is the extension name, the dependency's plugin name,
 * the skill name, the connector template id or the agent template name.
 */
export interface UpgradeComponent {
  kind: ComponentKind;
  ref: string;
  change: UpgradeChange;
  detail?: string;
}

/** `POST …/plugin-installs/:installId/upgrade/preview` (spec §10, step 1). */
export interface UpgradePreview {
  from: string;
  to: string;
  /** Confirm with it; it changes when the target, the install's components or the inputs change. */
  diffHash: string;
  components: UpgradeComponent[];
  inputs: {
    /** Added templates: their connectors are created with the org's input (as at install). */
    connectors: string[];
    /** Changed templates whose auth method or required credentials changed: re-entry needed. */
    credentialsChanged: string[];
    /** The extension is added and not yet enabled in the org: its org config may be given. */
    extensionConfig: boolean;
  };
  /**
   * The target version's connector templates named in `inputs.connectors` and
   * `inputs.credentialsChanged` (presets and auth, no credentials), for the input form: the target
   * is not always the latest version (an extension's plugin moves to the deployed version).
   */
  templates: OrgCatalogTemplate[];
}

/** The body of `POST …/plugin-installs/:installId/upgrade`. */
export interface PluginUpgradeInput extends PluginInstallInput {
  version: string;
  diffHash: string;
}

/** The steps of an upgrade, in order (`finish`: the removals and the version switch). */
type UpgradeStepName =
  | "dependencies"
  | "extension"
  | "skills"
  | "agent_templates"
  | "connectors"
  | "finish";

interface LedgerRow {
  kind: ComponentKind;
  ref: string;
  created: boolean;
  skill_version: number | null;
  template_id: string | null;
  dropped: boolean;
}

interface VersionRow extends CatalogVersionFiles {
  version: string;
  manifest: PluginManifest;
  source_format: SourceFormat;
}

interface SkillDiff {
  name: string;
  change: UpgradeChange;
  /** The skill directory in the target version (added / changed / unchanged). */
  dir?: string;
  /** The target version suggests pinning the skill (spec §9.1). */
  suggestPinned?: boolean;
  /** The ledger row of the org skill (by skill id), when the install has one that is live. */
  ledger?: LedgerRow;
}

interface AgentTemplateDiff {
  name: string;
  change: UpgradeChange;
  /** The target version's template (added / changed / unchanged). */
  template?: AgentTemplate;
  /** The ledger row of the org template, when the install has one that is live. */
  ledger?: LedgerRow;
}

interface TemplateDiff {
  id: string;
  change: UpgradeChange;
  target?: ConnectorTemplateFile;
  /** The org connector created from the template (live), when the install has one. */
  connector?: { id: string; connector: string; endpoint: unknown; auth: ConnectorAuth };
  ledger?: LedgerRow;
  credentialsChanged: boolean;
}

interface DependencyDiff {
  name: string;
  change: UpgradeChange;
  range?: string;
  fromRange?: string;
  resolved?: ResolvedDependency;
  /** The dependency install recorded in the ledger. */
  child?: { installId: string; version: string; ledger: LedgerRow };
  /** Added: null when already installed in the org (recorded created=false). */
  plan?: InstallPlan | null;
}

/**
 * Everything an upgrade will do, computed before anything is written (opaque outside this module:
 * {@link PluginUpgrader.check} hands it to {@link PluginUpgrader.upgrade}).
 */
export interface UpgradeDiff {
  installId: string;
  itemId: string;
  name: string;
  from: VersionRow;
  to: VersionRow;
  ledger: LedgerRow[];
  extension: { change: UpgradeChange; name: string } | null;
  skills: SkillDiff[];
  agentTemplates: AgentTemplateDiff[];
  templates: TemplateDiff[];
  dependencies: DependencyDiff[];
  components: UpgradeComponent[];
  inputs: UpgradePreview["inputs"];
  diffHash: string;
  ledgerHash: string;
  actions: OrgAction[];
  /** With input: the connectors to create and the template updates to prepare. */
  creates: Map<string, CreateConnectorInput>;
  updates: Map<string, TemplateUpdateInput>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const installNotFound = () => new ApiError("plugin.install_not_found", "Plugin install not found");
const inProgress = () =>
  new ApiError(
    "plugin.install_in_progress",
    "This plugin install is being installed, upgraded or uninstalled; try again when it finishes",
  );
const stale = () =>
  new ApiError(
    "plugin.upgrade_stale",
    "The upgrade preview is out of date (the catalog version or this install's components changed); preview the upgrade again",
  );
const targetInvalid = (message: string, details?: unknown[]) =>
  new ApiError("plugin.upgrade_target_invalid", message, details);
const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * What a credential of `auth` looks like: two auths with the same key take the same stored
 * credential (static: the type family, ownership and header names; OAuth: any change re-enters).
 */
function credentialKey(auth: ConnectorAuth): string {
  switch (auth.type) {
    case "none":
      return "none";
    case "bearer":
    case "api_key":
      return `token:${auth.ownership}`;
    case "basic":
      return `basic:${auth.ownership}`;
    case "headers":
      return `headers:${auth.ownership}:${[...auth.names].sort().join(",")}`;
    default:
      return canonicalJson(auth);
  }
}

/** The digest of all files of a catalog version. */
const filesDigest = (row: CatalogVersionFiles): string =>
  sha256(
    row.files
      .map((f) => `${f.path}\0${f.sha256}\n`)
      .sort()
      .join(""),
  );

/** The digest of the files under `dir/` of a catalog version (paths relative to it). */
function dirDigest(row: CatalogVersionFiles, dir: string): string {
  const prefix = `${dir}/`;
  return sha256(
    row.files
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => `${f.path.slice(prefix.length)}\0${f.sha256}\n`)
      .sort()
      .join(""),
  );
}

/**
 * Org in-place upgrade (and, for declarative plugins, rollback) of an installed plugin (package
 * ecosystem spec §10, Decisions 9–11):
 * - **preview** diffs the installed and the target version per component (extension, dependency
 *   plugins, skills by name, connector templates by id) and returns the inputs needed and a
 *   `diffHash`; the same checks as an install run first (dependencies resolve, extension and
 *   template connectors deployed, skill conflicts -> `plugin.skill_conflict`), plus the target
 *   rules (`plugin.upgrade_target_invalid`): an extension-bearing plugin can move only to the
 *   catalog version carrying the deployment's extension, and installs depending on this plugin must
 *   still accept the target;
 * - **upgrade** re-checks the `diffHash` (`plugin.upgrade_stale`), sets the install `upgrading`
 *   under the org lock (another upgrade or an uninstall -> `plugin.install_in_progress`), then:
 *   added dependencies (installed by the install flow), the added extension (enabled), added and
 *   changed skills (a new version of the same skill; agents keep selecting it by id), added
 *   connectors (created from the template), and in one final transaction the changed connectors
 *   (template-owned fields only, `applyTemplateIn`), the removals by the uninstall rules, the new
 *   version and the audit `plugin.org_upgraded`. Each step is journaled in
 *   `plugin_installs.upgrade`; on failure the journal is undone (created components removed, skill
 *   versions reverted; changed connectors were never committed), the install stays `installed` at
 *   the old version with `error = { step, code }`, audit `plugin.org_upgrade_failed`, 502
 *   `plugin.upgrade_failed`. An upgrade interrupted for longer than `catalog.staleInstallMinutes`
 *   is undone by the next preview, upgrade or uninstall.
 * Approval follows the item's policy (the org catalog service creates the request). No in-process
 * state.
 */
export class PluginUpgrader {
  private readonly d: PluginInstallerDeps;

  constructor(private readonly installer: PluginInstaller) {
    this.d = installer.deps;
  }

  /** The upgrade preview (see the class comment). */
  async preview(
    orgId: string,
    actor: string,
    installId: string,
    version: string,
  ): Promise<UpgradePreview> {
    await this.recoverInterrupted(orgId, actor, installId);
    const diff = await this.diff(orgId, actor, installId, version, null);
    await this.d.db
      .transaction()
      .execute(() => lockOrgForActions(this.d.orgLock, orgId, actor, diff.actions));
    return {
      from: diff.from.version,
      to: diff.to.version,
      diffHash: diff.diffHash,
      components: diff.components,
      inputs: diff.inputs,
      templates: diff.templates.flatMap((c) =>
        c.target !== undefined &&
        (diff.inputs.connectors.includes(c.id) || diff.inputs.credentialsChanged.includes(c.id))
          ? [orgTemplateView(c.id, c.target)]
          : [],
      ),
    };
  }

  /**
   * The checks of {@link upgrade} before an approval request (the org catalog service creates one
   * for a needs_approval item without a grant): the diff with the input, the `diffHash`. Returns
   * the item and the org actions the upgrade needs.
   */
  async check(
    orgId: string,
    actor: string,
    installId: string,
    input: PluginUpgradeInput,
  ): Promise<{ itemId: string; name: string; actions: OrgAction[]; diff: UpgradeDiff }> {
    await this.recoverInterrupted(orgId, actor, installId);
    const diff = await this.diff(orgId, actor, installId, input.version, input);
    if (diff.diffHash !== input.diffHash) throw stale();
    return { itemId: diff.itemId, name: diff.name, actions: diff.actions, diff };
  }

  /**
   * Runs an upgrade (see the class comment); returns the install view. `checked` is the diff
   * {@link check} computed for the same input (re-verified under the org lock: the install's
   * version and ledger must be unchanged), otherwise it is computed here.
   */
  async upgrade(
    orgId: string,
    actor: string,
    installId: string,
    input: PluginUpgradeInput,
    opts: { actorTokenId?: string } = {},
    checked?: UpgradeDiff,
  ): Promise<PluginInstallView> {
    let diff: UpgradeDiff;
    if (
      checked !== undefined &&
      checked.installId === installId &&
      checked.to.version === input.version &&
      checked.diffHash === input.diffHash
    ) {
      diff = checked;
    } else {
      await this.recoverInterrupted(orgId, actor, installId);
      diff = await this.diff(orgId, actor, installId, input.version, input);
      if (diff.diffHash !== input.diffHash) throw stale();
    }
    const { itemId } = diff;
    const upgradeId = randomUUID();

    // Start: the install `upgrading`, under the org lock (one upgrade or uninstall at a time)
    await this.d.db.transaction().execute(async (t) => {
      await lockOrgForActions(this.d.orgLock, orgId, actor, diff.actions);
      const row = await t
        .selectFrom("plugin_installs")
        .select(["status", "version"])
        .where("id", "=", installId)
        .where("org_id", "=", orgId)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.status === "failed") throw installNotFound();
      if (row.status !== "installed") throw inProgress();
      if (
        row.version !== diff.from.version ||
        ledgerHash(await ledgerOf(t, installId)) !== diff.ledgerHash
      ) {
        throw stale();
      }
      await assertItemInstallable(t, orgId, itemId);
      await t
        .updateTable("plugin_installs")
        .set({
          status: "upgrading",
          upgrade: sql<string>`jsonb_build_object('id', ${upgradeId}::text, 'from', ${diff.from.version}::text, 'to', ${diff.to.version}::text, 'startedAt', now(), 'done', '[]'::jsonb)`,
        })
        .where("id", "=", installId)
        .execute();
    });

    const done: UpgradeStep[] = [];
    /** The step whose journal write found the journal gone (cleaned up as interrupted meanwhile). */
    let unjournaled: UpgradeStep | undefined;
    // Appends a step to the journal (the journal gone: the upgrade was cleaned up as interrupted)
    const journal = async (s: UpgradeStep, t: Trx | KernelSchemaDb) => {
      done.push(s);
      unjournaled = s;
      const r = await t
        .updateTable("plugin_installs")
        .set({
          upgrade: sql<string>`jsonb_set(upgrade, '{done}', (upgrade->'done') || ${JSON.stringify([s])}::jsonb)`,
        })
        .where("id", "=", installId)
        .where(sql<string>`upgrade->>'id'`, "=", upgradeId)
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) throw cleanedUp();
      unjournaled = undefined;
    };
    // Records a component in the ledger and the journal, in the given transaction
    const record = async (
      c: {
        kind: ComponentKind;
        ref: string;
        created: boolean;
        skillVersion: number | null;
        templateId?: string;
      },
      t: Trx,
    ) => {
      const inserted = await t
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
        .returning("ref")
        .executeTakeFirst();
      if (c.created) await journal({ op: "created", kind: c.kind, ref: c.ref }, t);
      else if (inserted) await journal({ op: "recorded", kind: c.kind, ref: c.ref }, t);
    };

    let step: UpgradeStepName = "dependencies";
    const disabled: string[] = [];
    try {
      for (const dep of diff.dependencies.filter((x) => x.change === "added")) {
        const resolved = dep.resolved as ResolvedDependency;
        const rec = (c: Parameters<typeof record>[0], t: Trx) => record(c, t);
        if ((await this.installer.recordDependency(orgId, resolved, rec)) !== undefined) continue;
        if (!dep.plan) {
          throw new ApiError(
            "catalog.dependency_unresolved",
            `Dependency ${dep.name}@${resolved.range} cannot be resolved: its install in this organization was removed meanwhile; try again`,
            [{ dependency: dep.name, range: resolved.range }],
          );
        }
        let child: string;
        try {
          child = await this.installer.execute(orgId, actor, dep.plan, opts, {
            actions: requiredActions(dep.plan.manifest),
            approvedBy: itemId,
            parent: installId,
          });
        } catch (e) {
          if (e instanceof InstallFailure) {
            throw new InstallFailure(e.step, e.cause, [dep.name, ...e.dependency], e.rolledBack);
          }
          if (
            e instanceof ApiError &&
            e.code === "plugin.already_installed" &&
            (await this.installer.recordDependency(orgId, resolved, rec)) !== undefined
          ) {
            continue;
          }
          throw new InstallFailure("dependencies", e, [dep.name], true);
        }
        await this.installer.recordDependency(orgId, resolved, rec, child);
      }

      step = "extension";
      if (diff.extension?.change === "added") {
        const name = diff.extension.name;
        await this.d.orgConfigs.put(
          orgId,
          name,
          {
            enabled: true,
            ...(input.extensionConfig !== undefined && { config: input.extensionConfig }),
          },
          actor,
          opts.actorTokenId,
          {
            viaItem: itemId,
            ifDisabled: { skipped: false },
            inTransaction: (t, skipped) =>
              record({ kind: "extension", ref: name, created: !skipped, skillVersion: null }, t),
          },
        );
      }

      step = "skills";
      for (const s of diff.skills) {
        if (s.change !== "added" && s.change !== "changed") continue;
        const files = await readCatalogFiles(
          this.d.storage,
          diff.to.object_prefix,
          diff.to.files,
          s.dir as string,
        );
        const r = await this.d.skills.createVersionFromFiles(
          orgId,
          actor,
          { ...skillOf(files), files },
          {
            catalog: {
              itemId,
              version: diff.to.version,
              format: diff.to.source_format,
              suggestPinned: s.suggestPinned === true,
            },
            ...opts,
          },
        );
        await this.d.db.transaction().execute(async (t) => {
          if (r.created) {
            await record({ kind: "skill", ref: r.skill.id, created: true, skillVersion: null }, t);
            return;
          }
          await journal({ op: "skill_version", ref: r.skill.id, version: r.version }, t);
          await record(
            { kind: "skill", ref: r.skill.id, created: false, skillVersion: r.version },
            t,
          );
        });
      }

      step = "agent_templates";
      for (const a of diff.agentTemplates) {
        if (a.change !== "added" && a.change !== "changed") continue;
        await this.d.db.transaction().execute(async (t) => {
          await this.d.orgLock.lock(orgId);
          const r = await putTemplateVersionIn(
            t,
            {
              orgId,
              plugin: diff.name,
              catalogItemId: itemId,
              catalogVersion: diff.to.version,
              sourceFormat: diff.to.source_format,
            },
            a.template as AgentTemplate,
          );
          if (r.created) {
            await record(
              { kind: "agent_template", ref: r.id, created: true, skillVersion: null },
              t,
            );
            return;
          }
          if (r.changed)
            await journal({ op: "template_version", ref: r.id, version: r.version }, t);
          await record(
            {
              kind: "agent_template",
              ref: r.id,
              created: false,
              skillVersion: r.changed ? r.version : null,
            },
            t,
          );
        });
      }

      step = "connectors";
      for (const [templateId, ci] of diff.creates) {
        const r = await this.d.connectors.create(orgId, actor, ci, opts.actorTokenId);
        await this.d.db.transaction().execute((t) =>
          record(
            {
              kind: "connector",
              ref: r.connector.id,
              created: true,
              skillVersion: null,
              templateId,
            },
            t,
          ),
        );
      }
      const prepared: { connectorId: string; p: PreparedTemplateUpdate }[] = [];
      for (const tpl of diff.templates) {
        const update = diff.updates.get(tpl.id);
        if (!update || !tpl.connector) continue;
        try {
          prepared.push({
            connectorId: tpl.connector.id,
            p: await this.d.connectors.prepareTemplateUpdate(
              actor,
              tpl.connector.connector,
              update,
            ),
          });
        } catch (e) {
          throw under(e, `connectors.${tpl.id}`);
        }
      }

      // Finish, in one transaction: changed connectors, removals, the version switch
      await this.d.db.transaction().execute(async (t) => {
        await lockOrgForActions(this.d.orgLock, orgId, actor, diff.actions);
        const row = await t
          .selectFrom("plugin_installs")
          .select(["status", sql<string | null>`upgrade->>'id'`.as("upgradeId")])
          .where("id", "=", installId)
          .forUpdate()
          .executeTakeFirst();
        if (row?.status !== "upgrading" || row.upgradeId !== upgradeId) throw cleanedUp();
        await assertItemInstallable(t, orgId, itemId);
        for (const c of prepared) {
          await this.d.connectors.applyTemplateIn(
            t,
            orgId,
            c.connectorId,
            actor,
            c.p,
            opts.actorTokenId,
          );
        }
        step = "finish";
        for (const dep of diff.dependencies) {
          if (dep.change !== "changed" || !dep.child) continue;
          const live = await t
            .selectFrom("plugin_installs")
            .select("version")
            .where("id", "=", dep.child.installId)
            .forShare()
            .executeTakeFirst();
          if (!live || !satisfiesRange(live.version, dep.range as string)) {
            throw new ApiError(
              "catalog.dependency_unresolved",
              `Dependency ${dep.name}@${dep.range} cannot be resolved: its install in this organization changed meanwhile; preview the upgrade again`,
              [{ dependency: dep.name, range: dep.range }],
            );
          }
        }
        const report = await this.removeIn(t, orgId, actor, diff, disabled);
        // An unchanged skill gets no new version, so the target's pinned suggestion goes onto its
        // current version (when that version is this plugin's) here, with the version switch.
        for (const sk of diff.skills) {
          if (sk.change !== "unchanged" || !sk.ledger) continue;
          await t
            .updateTable("skill_versions as v")
            .set({ suggest_pinned: sk.suggestPinned === true })
            .from("skills as s")
            .whereRef("s.id", "=", "v.skill_id")
            .whereRef("s.current_version", "=", "v.version")
            .where("s.id", "=", sk.ledger.ref)
            .where("s.org_id", "=", orgId)
            .where("v.catalog_item_id", "=", itemId)
            .where("v.suggest_pinned", "<>", sk.suggestPinned === true)
            .execute();
        }
        await t
          .updateTable("plugin_installs")
          .set({ version: diff.to.version, status: "installed", upgrade: null, error: null })
          .where("id", "=", installId)
          .execute();
        await this.d.requests.resolveByInstall(t, orgId, itemId, actor, opts);
        await audit(t, {
          actorAccountId: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          orgId,
          action: "plugin.org_upgraded",
          target: installId,
          detail: {
            itemId,
            name: diff.name,
            from: diff.from.version,
            to: diff.to.version,
            components: diff.components,
            removed: report.removed,
            kept: report.kept,
          },
        });
      });
    } catch (e) {
      throw await this.failed(
        orgId,
        actor,
        installId,
        upgradeId,
        diff,
        { done, unjournaled },
        step,
        e,
        opts,
      );
    }
    for (const p of disabled) await this.d.orgConfigs.afterDisable(orgId, p);
    const [view] = await this.installer.list(orgId, installId);
    if (!view) throw installNotFound();
    return view;
  }

  /**
   * Undoes a failed upgrade (its journal, in one transaction): the install back `installed` at the
   * old version with `error = { step, code }`, audit `plugin.org_upgrade_failed`. When the journal
   * is no longer this upgrade's (another request cleaned it up as interrupted and undid what it
   * journaled), only the step whose journal write failed is undone and the install row is left as
   * the cleanup set it. Returns the error to throw: 502 `plugin.upgrade_failed` (a dependency
   * another install is still installing: its 409 as it is).
   */
  private async failed(
    orgId: string,
    actor: string,
    installId: string,
    upgradeId: string,
    diff: UpgradeDiff,
    steps: { done: UpgradeStep[]; unjournaled: UpgradeStep | undefined },
    step: UpgradeStepName,
    e: unknown,
    opts: { actorTokenId?: string },
  ): Promise<ApiError> {
    const failure = e instanceof InstallFailure ? e : undefined;
    const cause = failure ? failure.cause : e;
    const code = cause instanceof ApiError ? cause.code : "internal";
    const at = failure ? failure.step : step;
    let rolledBack = failure?.rolledBack ?? true;
    try {
      const removed = await this.d.db.transaction().execute(async (t) => {
        await this.d.orgLock.lock(orgId);
        const row = await t
          .selectFrom("plugin_installs")
          .select(sql<string | null>`upgrade->>'id'`.as("upgradeId"))
          .where("id", "=", installId)
          .forUpdate()
          .executeTakeFirst();
        const ours = row?.upgradeId === upgradeId;
        // Cleaned up meanwhile: only the step whose journal write found the journal gone is ours to
        // undo. When that step ran in the same transaction as its journal write (the extension
        // enable, the ledger rows), the transaction rolled back with the failed write, so undoing
        // it is a no-op (a never-enabled extension, a never-inserted row); undoing is still safe.
        const undo = ours ? steps.done : steps.unjournaled ? [steps.unjournaled] : [];
        const out = await this.installer.undoUpgradeIn(
          t,
          orgId,
          actor,
          installId,
          undo,
          "plugin_upgrade_rollback",
        );
        await t
          .updateTable("plugin_installs")
          .set({ status: "installed", upgrade: null, error: JSON.stringify({ step: at, code }) })
          .where("id", "=", installId)
          .where(sql<string>`upgrade->>'id'`, "=", upgradeId)
          .execute();
        await audit(t, {
          actorAccountId: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          orgId,
          action: "plugin.org_upgrade_failed",
          target: installId,
          detail: {
            itemId: diff.itemId,
            name: diff.name,
            from: diff.from.version,
            to: diff.to.version,
            step: at,
            code,
            rolledBack: undo,
            ...(!ours && { cleanedUpMeanwhile: true }),
          },
        });
        return out;
      });
      for (const r of removed) {
        if (r.kind === "extension") await this.d.orgConfigs.afterDisable(orgId, r.ref);
      }
    } catch (u) {
      // Left `upgrading` with its journal: undone once it is older than catalog.staleInstallMinutes
      rolledBack = false;
      this.d.log?.warn("plugin upgrade rollback failed", {
        orgId,
        installId,
        error: u instanceof Error ? u.message : String(u),
      });
    }
    if (cause instanceof ApiError && cause.code === "plugin.install_in_progress" && rolledBack) {
      return cause;
    }
    const dependency = failure && failure.dependency.length > 0 ? failure.dependency : [];
    const dep = dependency.length > 0 ? ` in dependency ${dependency.join(" > ")}` : "";
    return new ApiError(
      "plugin.upgrade_failed",
      rolledBack
        ? `Upgrading the plugin failed at step ${at}${dep} (${code}); this organization's components are back at version ${diff.from.version}`
        : `Upgrading the plugin failed at step ${at}${dep} (${code}) and rolling back failed; it is undone after catalog.staleInstallMinutes`,
      [
        {
          step: at,
          code,
          ...(dependency.length > 0 && { dependency: dependency.join(" > ") }),
          ...(cause instanceof ApiError && { message: cause.message }),
          ...(cause instanceof ApiError &&
            cause.details !== undefined && { causeDetails: cause.details }),
          rolledBack,
        },
      ],
    );
  }

  /**
   * An upgrade interrupted for longer than `catalog.staleInstallMinutes` (a replica crashed
   * midway): its journal is undone, the install back `installed` at the old version (error step
   * `interrupted`), audit `plugin.org_upgrade_failed`. Nothing to do otherwise.
   */
  private async recoverInterrupted(orgId: string, actor: string, installId: string): Promise<void> {
    if (!UUID_RE.test(installId)) throw installNotFound();
    const staleMinutes = this.d.staleInstallMinutes();
    const removed = await this.d.db.transaction().execute(async (t) => {
      const peek = await t
        .selectFrom("plugin_installs")
        .select("status")
        .where("id", "=", installId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (peek?.status !== "upgrading") return [];
      await this.d.orgLock.lock(orgId);
      const row = await t
        .selectFrom("plugin_installs as a")
        .innerJoin("catalog_items as i", "i.id", "a.item_id")
        .select([
          "a.status",
          "a.upgrade",
          "a.item_id",
          "i.name",
          sql<boolean>`coalesce((a.upgrade->>'startedAt')::timestamptz < now() - make_interval(mins => ${staleMinutes}), false)`.as(
            "stale",
          ),
        ])
        .where("a.id", "=", installId)
        .where("a.org_id", "=", orgId)
        .forUpdate("a")
        .executeTakeFirst();
      if (row?.status !== "upgrading" || !row.stale) return [];
      const steps = journalEntries(row.upgrade);
      const out = await this.installer.undoUpgradeIn(
        t,
        orgId,
        actor,
        installId,
        steps,
        "plugin_upgrade_cleanup",
      );
      await t
        .updateTable("plugin_installs")
        .set({
          status: "installed",
          upgrade: null,
          error: JSON.stringify({ step: "interrupted", code: "internal" }),
        })
        .where("id", "=", installId)
        .execute();
      const j = row.upgrade as { from?: unknown; to?: unknown } | null;
      await audit(t, {
        actorAccountId: actor,
        orgId,
        action: "plugin.org_upgrade_failed",
        target: installId,
        detail: {
          itemId: row.item_id,
          name: row.name,
          from: j?.from ?? null,
          to: j?.to ?? null,
          step: "interrupted",
          code: "internal",
          rolledBack: steps,
        },
      });
      return out;
    });
    for (const r of removed) {
      if (r.kind === "extension") await this.d.orgConfigs.afterDisable(orgId, r.ref);
    }
  }

  /**
   * The removals of an upgrade, in the final transaction, by the uninstall rules
   * (`decideRemovalIn`): only components this install created are removed, and only when nothing
   * else uses them; one still used (by an agent, a connector or another extension) stays in the
   * ledger marked `dropped` ("no longer in the plugin", still this install's), every other removed
   * component leaves the ledger; a dropped component the target brings back is un-dropped. A dependency
   * install is uninstalled by the same rules (another install using it takes it over). Skills ->
   * connectors -> extension -> dependencies.
   */
  private async removeIn(
    t: Trx,
    orgId: string,
    actor: string,
    diff: UpgradeDiff,
    disabled: string[],
  ): Promise<UninstallReport> {
    const report: UninstallReport = { removed: [], kept: [] };
    const reason = "plugin_upgrade";
    const keep = (
      kind: ComponentKind,
      ref: string,
      why: UninstallReport["kept"][number]["reason"],
    ) => report.kept.push({ kind, ref, reason: why });
    const row = (kind: ComponentKind, ref: string) =>
      t
        .updateTable("plugin_install_components")
        .where("install_id", "=", diff.installId)
        .where("kind", "=", kind)
        .where("ref", "=", ref);
    const dropRow = (kind: ComponentKind, ref: string) =>
      t
        .deleteFrom("plugin_install_components")
        .where("install_id", "=", diff.installId)
        .where("kind", "=", kind)
        .where("ref", "=", ref)
        .execute();
    const removed: LedgerRow[] = [
      ...diff.skills.flatMap((x) => (x.change === "removed" && x.ledger ? [x.ledger] : [])),
      ...diff.agentTemplates.flatMap((x) => (x.change === "removed" && x.ledger ? [x.ledger] : [])),
      ...diff.templates.flatMap((x) => (x.change === "removed" && x.ledger ? [x.ledger] : [])),
      ...(diff.extension?.change === "removed"
        ? diff.ledger.filter((l) => l.kind === "extension" && l.ref === diff.extension?.name)
        : []),
    ];
    const agentRefs = await this.installer.agentRefs(t, orgId);
    const self = new Set([diff.installId]);
    for (const l of removed) {
      if (!l.created) {
        await dropRow(l.kind, l.ref);
        keep(l.kind, l.ref, "pre_existing");
        continue;
      }
      const outcome = await this.installer.decideRemovalIn(
        t,
        orgId,
        actor,
        { kind: l.kind, ref: l.ref, created: true, skillVersion: null },
        self,
        agentRefs,
        reason,
      );
      if (
        outcome === "used_by_agents" ||
        outcome === "used_by_connectors" ||
        outcome === "used_by_plugins"
      ) {
        // Still used: stays this install's, marked dropped, so an uninstall (or a later upgrade
        // bringing it back) still finds it
        await row(l.kind, l.ref).set({ dropped: true }).execute();
        keep(l.kind, l.ref, outcome);
        continue;
      }
      await dropRow(l.kind, l.ref);
      if (outcome === "removed") {
        report.removed.push({ kind: l.kind, ref: l.ref });
        if (l.kind === "extension") disabled.push(l.ref);
      } else if (outcome !== "gone") keep(l.kind, l.ref, outcome);
    }
    // Components back in the plugin (dropped by an earlier upgrade, brought again by the target)
    const back: { kind: ComponentKind; ref: string }[] = [
      ...diff.skills.flatMap((x) =>
        x.change !== "removed" && x.ledger?.dropped
          ? [{ kind: "skill" as const, ref: x.ledger.ref }]
          : [],
      ),
      ...diff.agentTemplates.flatMap((x) =>
        x.change !== "removed" && x.ledger?.dropped
          ? [{ kind: "agent_template" as const, ref: x.ledger.ref }]
          : [],
      ),
      ...diff.templates.flatMap((x) =>
        x.change !== "removed" && x.ledger?.dropped
          ? [{ kind: "connector" as const, ref: x.ledger.ref }]
          : [],
      ),
      ...(diff.extension && diff.extension.change !== "removed"
        ? diff.ledger
            .filter((l) => l.kind === "extension" && l.ref === diff.extension?.name && l.dropped)
            .map((l) => ({ kind: "extension" as const, ref: l.ref }))
        : []),
    ];
    for (const b of back) await row(b.kind, b.ref).set({ dropped: false }).execute();
    for (const dep of diff.dependencies) {
      if (dep.change !== "removed" || !dep.child) continue;
      const ref = dep.child.installId;
      await dropRow("plugin", ref);
      if (!dep.child.ledger.created) {
        keep("plugin", ref, "pre_existing");
        continue;
      }
      const sub: UninstallReport = { removed: [], kept: [] };
      const outcome = await this.installer.uninstallIn(t, orgId, actor, ref, {
        report: sub,
        removing: new Set(),
        from: diff.installId,
        authorize: false,
        reason,
        opts: {},
      });
      for (const r of sub.removed) if (r.kind === "extension") disabled.push(r.ref);
      if (outcome === "removed") report.removed.push({ kind: "plugin", ref });
      else if (outcome === "kept") keep("plugin", ref, "used_by_other_install");
    }
    return report;
  }

  /**
   * Computes an upgrade (see the class comment). `input` null: the preview (no input checks);
   * otherwise the connector inputs are built and checked as at install.
   */
  private async diff(
    orgId: string,
    actor: string,
    installId: string,
    version: string,
    input: PluginInstallInput | null,
  ): Promise<UpgradeDiff> {
    const db = this.d.db;
    if (!UUID_RE.test(installId)) throw installNotFound();
    const install = await db
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
      .select(["a.item_id", "a.version", "a.status", "i.name", "i.policy", "i.deleted_at"])
      .where("a.id", "=", installId)
      .where("a.org_id", "=", orgId)
      .executeTakeFirst();
    if (!install || install.status === "failed") throw installNotFound();
    if (install.status !== "installed") throw inProgress();
    const itemId = install.item_id;
    const name = install.name;
    if (install.deleted_at !== null) {
      throw new ApiError(
        "catalog.item_not_found",
        "This plugin is no longer in the enterprise catalog",
      );
    }
    if (install.policy === "disabled") {
      throw new ApiError(
        "catalog.item_disabled",
        "This catalog item is disabled by the enterprise admin and cannot be upgraded",
      );
    }
    const versions = await db
      .selectFrom("catalog_item_versions")
      .select([
        "version",
        "manifest",
        "object_prefix",
        "files",
        "extension_sha256",
        "imported_at",
        "source_format",
      ])
      .where("item_id", "=", itemId)
      .execute();
    const fromRow = versions.find((v) => v.version === install.version);
    const toRow = versions.find((v) => v.version === version);
    if (!fromRow) {
      throw new ApiError(
        "catalog.item_not_found",
        `The installed version ${install.version} is no longer in the enterprise catalog`,
      );
    }
    if (!toRow)
      throw new ApiError("catalog.item_not_found", `Version ${version} of this item not found`);
    const from = fromRow as typeof fromRow & VersionRow;
    const to = toRow as typeof toRow & VersionRow;
    if (to.version === from.version) {
      // Confirming a preview whose upgrade already ran (a concurrent confirm won): stale
      if (input !== null) throw stale();
      throw targetInvalid(`This organization already has version ${from.version} installed`, [
        { reason: "same_version", version: from.version },
      ]);
    }

    // Target rules (Decision 10)
    if (to.manifest.extension) {
      const deployed = await deployedExtension(db, this.d.host, name);
      const allowed = deploymentTarget(versions, deployed);
      if (allowed?.version !== to.version) {
        throw targetInvalid(
          deployed === undefined
            ? `The deployment does not run the extension of plugin ${name}; ask the enterprise admin to install it first`
            : `The deployment runs the extension of plugin ${name} at version ${deployed.version}; this organization can upgrade only to ${allowed ? `catalog version ${allowed.version}` : "a catalog version carrying that extension, and none is imported"}`,
          [
            {
              reason: "deployment_version",
              deploymentVersion: deployed?.version ?? null,
              allowedVersion: allowed?.version ?? null,
            },
          ],
        );
      }
    }
    // Installs in this org depending on this one must accept the target
    const parents = await db
      .selectFrom("plugin_install_components as c")
      .innerJoin("plugin_installs as a", "a.id", "c.install_id")
      .innerJoin("catalog_item_versions as v", (j) =>
        j.onRef("v.item_id", "=", "a.item_id").onRef("v.version", "=", "a.version"),
      )
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
      .select(["i.name", "v.manifest"])
      .where("c.kind", "=", "plugin")
      .where("c.ref", "=", installId)
      .where("a.org_id", "=", orgId)
      .where("a.status", "<>", "failed")
      .execute();
    for (const p of parents) {
      const range = (p.manifest as PluginManifest).dependencies?.find(
        (x) => x.name === name,
      )?.version;
      if (range !== undefined && !satisfiesRange(to.version, range)) {
        throw targetInvalid(
          `Plugin ${p.name} installed in this organization depends on ${name}@${range}, which version ${to.version} does not satisfy`,
          [{ reason: "dependent_range", dependent: p.name, range, version: to.version }],
        );
      }
    }

    const ledger = await ledgerOf(db, installId);
    const components: UpgradeComponent[] = [];

    // Extension
    let extension: UpgradeDiff["extension"] = null;
    let extensionConfig = false;
    if (from.manifest.extension || to.manifest.extension) {
      const change: UpgradeChange = !from.manifest.extension
        ? "added"
        : !to.manifest.extension
          ? "removed"
          : from.extension_sha256 !== to.extension_sha256 ||
              from.manifest.extension.manifest.version !== to.manifest.extension.manifest.version
            ? "changed"
            : "unchanged";
      extension = { change, name };
      if (change === "added") {
        await this.installer.planExtension(orgId, to.manifest);
        extensionConfig = !(await isExtensionEnabled(db, orgId, name));
      }
      components.push({
        kind: "extension",
        ref: name,
        change,
        ...(change === "changed" && {
          detail: `${from.manifest.extension?.manifest.version} -> ${to.manifest.extension?.manifest.version}`,
        }),
      });
    }

    // Dependencies (by plugin name)
    const resolved = await resolveDependencies(db, to.manifest);
    const childIds = ledger.filter((l) => l.kind === "plugin").map((l) => l.ref);
    const children =
      childIds.length === 0
        ? []
        : await db
            .selectFrom("plugin_installs as a")
            .innerJoin("catalog_items as i", "i.id", "a.item_id")
            .select(["a.id", "a.version", "i.name"])
            .where("a.id", "in", childIds)
            .execute();
    const childOf = (n: string): DependencyDiff["child"] => {
      const c = children.find((x) => x.name === n);
      const l = c && ledger.find((x) => x.kind === "plugin" && x.ref === c.id);
      return c && l ? { installId: c.id, version: c.version, ledger: l } : undefined;
    };
    const dependencies: DependencyDiff[] = [];
    const fromDeps = from.manifest.dependencies ?? [];
    for (const r of resolved) {
      const before = fromDeps.find((x) => x.name === r.name);
      const child = childOf(r.name);
      if (before && child) {
        const change: UpgradeChange = before.version === r.range ? "unchanged" : "changed";
        if (change === "changed" && !satisfiesRange(child.version, r.range)) {
          throw new ApiError(
            "catalog.dependency_unresolved",
            `Dependency ${r.name}@${r.range} cannot be resolved: this organization has version ${child.version} installed; upgrade it first`,
            [{ dependency: r.name, range: r.range }],
          );
        }
        dependencies.push({
          name: r.name,
          change,
          range: r.range,
          fromRange: before.version,
          resolved: r,
          child,
        });
        continue;
      }
      // New (or its install was not recorded): installed by the install flow
      const live = await this.installer.liveDependency(db, orgId, r);
      dependencies.push({
        name: r.name,
        change: "added",
        range: r.range,
        resolved: r,
        plan:
          live !== undefined
            ? null
            : await this.installer.plan(
                orgId,
                actor,
                r.itemId,
                r.version,
                input === null ? null : {},
                `dependencies.${r.name}.`,
                itemId,
              ),
      });
    }
    for (const before of fromDeps) {
      if (resolved.some((r) => r.name === before.name)) continue;
      const child = childOf(before.name);
      dependencies.push({
        name: before.name,
        change: "removed",
        fromRange: before.version,
        ...(child && { child }),
      });
    }
    for (const dep of dependencies) {
      components.push({
        kind: "plugin",
        ref: dep.name,
        change: dep.change,
        ...(dep.change === "changed" && { detail: `${dep.fromRange} -> ${dep.range}` }),
        ...(dep.change === "added" && {
          detail: dep.plan === null ? "already installed" : `installs ${dep.resolved?.version}`,
        }),
      });
    }

    // Skills (by name)
    const fromNames = await catalogSkillNames(this.d.storage, from, from.manifest);
    const toNames = await catalogSkillNames(this.d.storage, to, to.manifest);
    const dirOf = (m: PluginManifest, i: number) =>
      packagePath((m.skills ?? [])[i]?.path as string);
    const fromSkills = new Map(fromNames.map((n, i) => [n, dirOf(from.manifest, i)]));
    const toSkills = new Map(toNames.map((n, i) => [n, dirOf(to.manifest, i)]));
    const toPinned = new Set(
      toNames.filter((_, i) => (to.manifest.skills ?? [])[i]?.pinned === true),
    );
    const skillRefs = ledger.filter((l) => l.kind === "skill").map((l) => l.ref);
    const liveSkills =
      skillRefs.length === 0
        ? []
        : await db
            .selectFrom("skills")
            .select(["id", "name"])
            .where("id", "in", skillRefs)
            .where("org_id", "=", orgId)
            .where("deleted_at", "is", null)
            .execute();
    const ledgerOfSkill = (n: string) => {
      const s = liveSkills.find((x) => x.name === n);
      return s && ledger.find((l) => l.kind === "skill" && l.ref === s.id);
    };
    const skills: SkillDiff[] = [];
    for (const [n, dir] of toSkills) {
      const before = fromSkills.get(n);
      const l = ledgerOfSkill(n);
      const change: UpgradeChange =
        before === undefined
          ? "added"
          : dirDigest(from, before) === dirDigest(to, dir)
            ? "unchanged"
            : "changed";
      skills.push({
        name: n,
        change,
        dir,
        suggestPinned: toPinned.has(n),
        ...(l && { ledger: l }),
      });
    }
    for (const n of fromSkills.keys()) {
      if (toSkills.has(n)) continue;
      const l = ledgerOfSkill(n);
      skills.push({ name: n, change: "removed", ...(l && { ledger: l }) });
    }
    for (const s of skills) components.push({ kind: "skill", ref: s.name, change: s.change });

    // The same skill conflict check as an install (spec §9.2)
    const conflicts = await planSkillConflicts(db, orgId, {
      itemId,
      name,
      version: to.version,
      skillNames: toNames,
      dependencies: dependencies
        .filter((x) => x.change === "added")
        .map((x) => ({ plan: x.plan ?? null })),
    });
    if (conflicts.length > 0) throw skillConflictError(conflicts);

    // Agent templates (by name; phase C)
    const fromAgents = await readCatalogAgentTemplates(this.d.storage, from);
    const toAgents = await readCatalogAgentTemplates(this.d.storage, to);
    const templateRefs = ledger.filter((l) => l.kind === "agent_template").map((l) => l.ref);
    const liveTemplates =
      templateRefs.length === 0
        ? []
        : await db
            .selectFrom("agent_templates")
            .select(["id", "name"])
            .where("id", "in", templateRefs)
            .where("org_id", "=", orgId)
            .where("deleted_at", "is", null)
            .execute();
    const ledgerOfTemplate = (n: string) => {
      const r = liveTemplates.find((x) => x.name === n);
      return r && ledger.find((l) => l.kind === "agent_template" && l.ref === r.id);
    };
    const agentTemplates: AgentTemplateDiff[] = [];
    for (const a of toAgents) {
      const n = a.template.name;
      const before = fromAgents.find((x) => x.template.name === n);
      const l = ledgerOfTemplate(n);
      const change: UpgradeChange =
        before === undefined
          ? "added"
          : canonicalJson(before.template) === canonicalJson(a.template)
            ? "unchanged"
            : "changed";
      agentTemplates.push({ name: n, change, template: a.template, ...(l && { ledger: l }) });
    }
    for (const a of fromAgents) {
      const n = a.template.name;
      if (toAgents.some((x) => x.template.name === n)) continue;
      const l = ledgerOfTemplate(n);
      agentTemplates.push({ name: n, change: "removed", ...(l && { ledger: l }) });
    }
    for (const a of agentTemplates) {
      components.push({ kind: "agent_template", ref: a.name, change: a.change });
    }

    // Connector templates (by id)
    const fromTemplates = await readCatalogTemplates(this.d.storage, from);
    const toTemplates = await readCatalogTemplates(this.d.storage, to);
    // The install's connectors by template; a dropped one (kept only for the agents using it) counts
    // only while its connector is live, so a template the target brings back maps onto it
    const connectorRows = ledger.filter((l) => l.kind === "connector" && l.template_id !== null);
    const liveConnectors =
      connectorRows.length === 0
        ? []
        : await db
            .selectFrom("connectors")
            .select(["id", "connector", "endpoint", "auth"])
            .where(
              "id",
              "in",
              connectorRows.map((l) => l.ref),
            )
            .where("org_id", "=", orgId)
            .where("deleted_at", "is", null)
            .execute();
    const connectorOf = (templateId: string) => {
      const rows = connectorRows.filter((x) => x.template_id === templateId);
      const l =
        rows.find((x) => !x.dropped) ??
        rows.find((x) => liveConnectors.some((c) => c.id === x.ref));
      const c = l && liveConnectors.find((x) => x.id === l.ref);
      return {
        ...(l && { ledger: l }),
        ...(c && {
          connector: {
            id: c.id,
            connector: c.connector,
            endpoint: c.endpoint,
            auth: c.auth as ConnectorAuth,
          },
        }),
      };
    };
    const deps = this.installer.templateDeps();
    const templates: TemplateDiff[] = [];
    for (const ct of toTemplates) {
      const problem = templatePluginProblem(deps, ct.file.template);
      const before = fromTemplates.find((x) => x.id === ct.id);
      const mapped = connectorOf(ct.id);
      if (!before && mapped.ledger?.dropped && mapped.connector) {
        // Back in the plugin (an earlier upgrade dropped it, its connector was kept): the kept
        // connector is updated to the template, not created again (its slug would be taken)
        if (problem !== undefined) throw new ApiError("catalog.not_deployed", problem);
        if (mapped.connector.connector !== ct.file.template.connector) {
          throw targetInvalid(
            `Connector template ${ct.id} comes back for another connector (${ct.file.template.plugin} "${ct.file.template.connector}"); uninstall the plugin and install the new version instead`,
            [
              {
                reason: "template_connector",
                template: ct.id,
                plugin: ct.file.template.plugin,
                connector: ct.file.template.connector,
              },
            ],
          );
        }
        const credentialsChanged =
          credentialKey(mapped.connector.auth) !==
          credentialKey(ct.file.template.auth as unknown as ConnectorAuth);
        templates.push({
          id: ct.id,
          change: "changed",
          target: ct.file,
          ...mapped,
          credentialsChanged,
        });
        continue;
      }
      if (!before) {
        if (problem !== undefined) throw new ApiError("catalog.not_deployed", problem);
        templates.push({ id: ct.id, change: "added", target: ct.file, credentialsChanged: false });
        continue;
      }
      const change: UpgradeChange =
        canonicalJson(before.file) === canonicalJson(ct.file) ? "unchanged" : "changed";
      if (change === "changed") {
        if (
          before.file.template.plugin !== ct.file.template.plugin ||
          before.file.template.connector !== ct.file.template.connector
        ) {
          throw targetInvalid(
            `Connector template ${ct.id} moves to another connector (${ct.file.template.plugin} "${ct.file.template.connector}"); uninstall the plugin and install the new version instead`,
            [
              {
                reason: "template_connector",
                template: ct.id,
                plugin: ct.file.template.plugin,
                connector: ct.file.template.connector,
              },
            ],
          );
        }
        if (problem !== undefined && mapped.connector) {
          throw new ApiError("catalog.not_deployed", problem);
        }
      }
      const credentialsChanged =
        change === "changed" &&
        mapped.connector !== undefined &&
        credentialKey(mapped.connector.auth) !==
          credentialKey(ct.file.template.auth as unknown as ConnectorAuth);
      templates.push({ id: ct.id, change, target: ct.file, ...mapped, credentialsChanged });
    }
    for (const ct of fromTemplates) {
      if (toTemplates.some((x) => x.id === ct.id)) continue;
      templates.push({
        id: ct.id,
        change: "removed",
        ...connectorOf(ct.id),
        credentialsChanged: false,
      });
    }
    for (const c of templates) {
      components.push({
        kind: "connector",
        ref: c.id,
        change: c.change,
        ...(c.credentialsChanged && { detail: "credentials change" }),
        ...(c.change !== "added" &&
          c.change !== "removed" &&
          !c.connector && { detail: "no connector in this organization" }),
      });
    }

    const inputs: UpgradePreview["inputs"] = {
      connectors: templates.filter((c) => c.change === "added").map((c) => c.id),
      credentialsChanged: templates.filter((c) => c.credentialsChanged).map((c) => c.id),
      extensionConfig,
    };

    // The inputs (as at install), when given
    const creates = new Map<string, CreateConnectorInput>();
    const updates = new Map<string, TemplateUpdateInput>();
    if (input !== null) {
      for (const k of Object.keys(input.connectors ?? {})) {
        if (!inputs.connectors.includes(k) && !inputs.credentialsChanged.includes(k)) {
          throw fail(
            `connectors.${k}`,
            "This upgrade takes no input for this connector template (only added templates and changed credentials)",
          );
        }
      }
      if (input.extensionConfig !== undefined && !inputs.extensionConfig) {
        throw fail("extensionConfig", "This upgrade does not enable the plugin's extension");
      }
      for (const c of templates) {
        if (c.change === "added") {
          creates.set(
            c.id,
            this.installer.planConnector(
              actor,
              { itemId, version: to.version, name },
              { id: c.id, file: c.target as ConnectorTemplateFile },
              input,
              "",
              undefined,
            ),
          );
          continue;
        }
        if (c.change !== "changed" || !c.connector || !c.target) continue;
        updates.set(c.id, this.templateUpdate(itemId, to.version, c, input));
      }
    }

    const actions = new Set<OrgAction>([
      ...requiredActions(from.manifest),
      ...requiredActions(to.manifest),
    ]);
    for (const dep of dependencies)
      if (dep.plan) for (const a of planActions(dep.plan)) actions.add(a);
    const removedDeps = dependencies.filter((x) => x.change === "removed" && x.child);
    if (removedDeps.length > 0) {
      const manifests = await db
        .selectFrom("plugin_installs as a")
        .innerJoin("catalog_item_versions as v", (j) =>
          j.onRef("v.item_id", "=", "a.item_id").onRef("v.version", "=", "a.version"),
        )
        .select("v.manifest")
        .where(
          "a.id",
          "in",
          removedDeps.map((x) => x.child?.installId as string),
        )
        .execute();
      for (const m of manifests)
        for (const a of requiredActions(m.manifest as PluginManifest)) actions.add(a);
    }

    const lh = ledgerHash(ledger);
    const diffHash = sha256(
      canonicalJson({
        installId,
        from: from.version,
        to: to.version,
        fromFiles: filesDigest(from),
        toFiles: filesDigest(to),
        ledger: lh,
        components,
        inputs,
      }),
    );
    return {
      installId,
      itemId,
      name,
      from,
      to,
      ledger,
      extension,
      skills,
      agentTemplates,
      templates,
      dependencies,
      components,
      inputs,
      diffHash,
      ledgerHash: lh,
      actions: [...actions],
      creates,
      updates,
    };
  }

  /**
   * The update of a changed template's connector: the new endpoint preset with the org's values at
   * the editable paths, the new auth preset and policies; credentials only when the auth method or
   * the credentials it needs changed (then the input must give what the template needs).
   */
  private templateUpdate(
    itemId: string,
    version: string,
    c: TemplateDiff,
    input: PluginInstallInput,
  ): TemplateUpdateInput {
    const template = (c.target as ConnectorTemplateFile).template;
    const connector = c.connector as NonNullable<TemplateDiff["connector"]>;
    const path = `connectors.${c.id}`;
    const given = input.connectors?.[c.id];
    if (given !== undefined) {
      for (const k of ["name", "slug", "endpoint"] as const) {
        if (given[k] !== undefined) {
          throw fail(
            `${path}.${k}`,
            "An existing connector keeps its name, slug and endpoint fields",
          );
        }
      }
    }
    const endpoint = structuredClone(template.endpoint) as Record<string, unknown>;
    for (const e of template.editableEndpoint ?? []) {
      const v = getPath(connector.endpoint, e);
      if (v !== undefined) setPath(endpoint, e, v);
    }
    const auth = template.auth as unknown as ConnectorAuth;
    const oauth = auth.type === "oauth_code" || auth.type === "oauth_client";
    if (c.credentialsChanged) {
      const missing = missingTemplateInput(template, given, { personalCredential: false });
      if (missing !== undefined) {
        throw fail(
          `${path}.${missing}`,
          `The auth method of this connector template changed; it needs ${missing === "client" ? "an OAuth client" : "an org credential"}`,
        );
      }
      if (oauth && given?.credential !== undefined) {
        throw fail(`${path}.credential`, "This connector uses OAuth; provide client instead");
      }
      if (!oauth && given?.client !== undefined) {
        throw fail(
          `${path}.client`,
          "This connector does not use OAuth; provide credential instead",
        );
      }
    }
    const credential = oauth ? given?.client : given?.credential;
    return {
      endpoint,
      auth,
      template: {
        itemId,
        version,
        templateId: c.id,
        ...(template.defaultToolPolicies !== undefined && {
          defaultToolPolicies: template.defaultToolPolicies,
        }),
      },
      resetCredentials: c.credentialsChanged,
      ...(c.credentialsChanged && credential !== undefined && { credential }),
    };
  }
}

const cleanedUp = () =>
  new ApiError(
    "plugin.install_not_found",
    "The upgrade was cleaned up as interrupted while it was running",
  );

/** The install's ledger rows. */
function ledgerOf(db: KernelSchemaDb | Trx, installId: string): Promise<LedgerRow[]> {
  return db
    .selectFrom("plugin_install_components")
    .select(["kind", "ref", "created", "skill_version", "template_id", "dropped"])
    .where("install_id", "=", installId)
    .orderBy("kind")
    .orderBy("ref")
    .execute();
}

/** A fingerprint of the ledger (order independent). */
function ledgerHash(rows: readonly LedgerRow[]): string {
  return sha256(
    rows
      .map(
        (r) =>
          `${r.kind}\0${r.ref}\0${r.created}\0${r.skill_version}\0${r.template_id}\0${r.dropped}\n`,
      )
      .sort()
      .join(""),
  );
}
