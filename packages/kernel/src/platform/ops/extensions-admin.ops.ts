import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  AdminExtensionConfigBody,
  AdminExtensionNamePathParams,
} from "../../admin/extensions.schemas.js";
import { type CatalogItemView, CatalogService } from "../../catalog/catalog.service.js";
import { ApiError } from "../../errors.js";
import { ExtensionAdminOps } from "../../extensions/admin-ops.js";
import { ExtensionAdmin } from "../../extensions/admin-view.js";
import {
  type DeploymentConfigView,
  ExtensionDeploymentConfigService,
} from "../../extensions/deployment-config.js";
import { ExtensionInstalls } from "../../extensions/installs.js";
import type { AdminExtensionView } from "../../extensions/permission-view.js";
import { PluginGuides, type RenderedSetupGuide } from "../../extensions/plugin-guides.js";
import {
  SINGLE_PROVIDER_ENABLED,
  SINGLE_PROVIDER_REQUIRED,
  singleProviderMessage,
} from "../../extensions/single-provider.js";
import { unavailableReason } from "../../extensions/unavailable.js";
import { LoginSourcesService } from "../../identity/login-sources.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import {
  DeploymentCheckPathParams,
  DeploymentCheckRunBody,
  DeploymentGuidePathParams,
  DeploymentGuidesPathParams,
  DeploymentGuidesQuery,
} from "../../setup/setup-checks.schemas.js";
import { SetupChecksService } from "../../setup/setup-checks.service.js";
import { FileRefSchema } from "../file-ref.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import {
  type PersonFieldTarget,
  pathsTouched,
  personFieldParams,
  secretFieldsOf,
} from "../person-fields.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { assertExtensionNotOtherOrgs, OTHER_ORG, otherOrgExtensions } from "./other-orgs.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { configChanges, flatValues, withPersonInputs } from "./person-inputs.js";
import { localized, named } from "./summary.js";
import { unavailableFields } from "./unavailable.js";

/** An extension's name (`:name` of the admin routes), bounded like the org routes' `:extension`. */
const Name = AdminExtensionNamePathParams.shape.name.max(64);
const NameInput = z.object({ name: Name }).strict();
const EXAMPLE = { name: "model-anthropic" };

/** `values` of the deployment config route: field dot path -> value (`null` clears). */
const ConfigValues = AdminExtensionConfigBody.shape.values;

/**
 * The person fields of an extension's deployment config (platform web parity spec §4.1): the
 * secret fields of its form schema, set or not. A secret field the schema walk cannot address (no
 * form schema, a record) is never asked, and a value for it in `values` is refused as web only. A
 * secret set in the startup config (read-only here) is never asked either: naming it in
 * `askPerson` / `clearSecrets`, or giving it in `values`, is refused before the card with the
 * route's `extension.config_readonly`, so the person never types a value the write would refuse.
 */
export function deploymentPersonFields(
  v: DeploymentConfigView,
  named: readonly string[] = [],
  values?: Readonly<Record<string, unknown>>,
): PersonFieldTarget {
  const secrets = v.fields.filter((f) => f.secret);
  const readonly = secrets.filter((f) => f.readonly);
  const ro = new Set(readonly.map((f) => f.path));
  const hit = [
    ...new Set([
      ...named.filter((p) => ro.has(p)),
      ...pathsTouched(
        values,
        readonly.map((f) => f.path),
      ),
    ]),
  ];
  if (hit.length > 0) {
    throw new ApiError(
      "extension.config_readonly",
      `These deployment config fields of extension ${v.plugin} are set in the startup config (file, Nacos or environment) and are read-only here: ${hit.join(", ")}`,
      hit.map((path) => ({ path, source: readonly.find((f) => f.path === path)?.source })),
    );
  }
  const found = secretFieldsOf(v.schema, new Set(secrets.filter((f) => f.set).map((f) => f.path)));
  const fields = found.fields.filter((f) => !ro.has(f.path));
  const asked = new Set(fields.map((f) => f.path));
  const n = localized(v.displayName, v.plugin);
  return {
    target: { zh: `扩展「${n.zh}」的部署配置`, en: `${n.en}: deployment config` },
    fields,
    recordOnly: [
      ...new Set([...found.recordOnly, ...secrets.map((f) => f.path).filter((p) => !asked.has(p))]),
    ],
  };
}

/**
 * What `extensions.platform-config` adds to the config view: the extension's platform setup guides
 * as a short list (id and title, no body), and a next step naming `extensions.platform-guides` when
 * a guide exists and the config needs setting up (invalid, or a required field without a value).
 */
export function configGuides(
  v: DeploymentConfigView,
  guides: readonly Pick<RenderedSetupGuide, "id" | "title">[],
): { guides: { id: string; title: string }[]; next?: string } {
  const list = guides.map((g) => ({ id: g.id, title: g.title }));
  if (list.length === 0 || !needsSetup(v)) return { guides: list };
  return {
    guides: list,
    next: "Required fields are unset or the config is invalid, and the extension ships platform setup guides (guides): read them with extensions.platform-guides, walk the person through their steps, then save the fields with extensions.platform-set-config.",
  };
}

/** Whether a deployment config is invalid or leaves a required field without a value. */
function needsSetup(v: DeploymentConfigView): boolean {
  if (!v.valid || v.orgMustConfigure.length > 0) return true;
  const required = (v.schema as { required?: unknown } | null)?.required;
  if (!Array.isArray(required)) return false;
  return v.fields.some(
    (f) => required.includes(f.path) && (f.secret ? f.set !== true : f.source === "unset"),
  );
}

/** The English name of an extension as next steps name it. */
const enName = (v: AdminExtensionView): string => localized(v.displayName, v.name).en;

/** Why an extension does not run, and the super admin's next step (absent when it runs). */
const why = (v: AdminExtensionView) => {
  if (v.status === "enabled") return {};
  const fields = unavailableFields(unavailableReason(v.status), enName(v), "superAdmin");
  if (v.status !== "conflict" || v.conflict === undefined || v.conflict.providers.length === 0)
    return fields;
  // A conflict names the extensions in the way: disabling them is the whole fix.
  const others = v.conflict.providers.map(
    (p) => `${localized(p.displayName, p.name).en} (${p.name})`,
  );
  return {
    ...fields,
    next: `Only one extension may provide ${v.conflict.extensionPoint}, and ${others.join(", ")} already does. Disable it (extensions.platform-disable, or the admin console → Extensions) and ${enName(v)} loads by itself, no restart.`,
  };
};

/** An extension as `extensions.platform-list` shows it: a compact row. */
const row = (v: AdminExtensionView) => ({
  id: v.name,
  name: enName(v),
  state: v.status,
  ...why(v),
  version: v.version,
  enabledOrgs: v.enabledOrgs,
  required: v.required,
});

/**
 * One extension as `extensions.platform-get` shows it: the admin console's view (status, replicas,
 * permissions and what changed since the approved snapshot, config validity as a flag) with the
 * reason and next step. Never a config value; the approval's `reviewHash` is left out (approving
 * permissions is done by a person on the web).
 */
const detail = (v: AdminExtensionView) => {
  const { reviewHash: _reviewHash, ...rest } = v;
  return { ...rest, ...why(v) };
};

/** Where a super admin confirms permissions: a person, on the web (spec §6.4). */
const CONFIRM_ON_WEB = "Review and confirm its permissions in the admin console.";

/** An extension waiting for a permission confirmation: a compact row, the keys it adds. */
const pendingExtension = (v: AdminExtensionView) => ({
  id: v.name,
  name: enName(v),
  state: v.status,
  kind: "extension" as const,
  version: v.version,
  permissions: { added: v.added, removed: v.removed, sensitive: v.sensitive },
  next: `${CONFIRM_ON_WEB} (Extensions → ${enName(v)})`,
});

/** A catalog plugin waiting for a permission confirmation (or this org's upload): a compact row. */
const pendingPlugin = (i: CatalogItemView) => ({
  id: i.id,
  name: i.name,
  state: "pending",
  kind: "plugin" as const,
  version: i.pendingVersion ?? i.latestVersion,
  owner: i.owner.kind === "org" ? i.owner.name : "platform",
  next: `${CONFIRM_ON_WEB} (plugins, pending tab)`,
});

/**
 * The super admin's extension operations of the `Platform` tool (spec §14.2 "admin console",
 * §14.5 item 1): the deployment's extensions (list, read), enable, disable and uninstall, and
 * storing an uploaded package (its review). Installing a package and approving permissions stay on
 * the web: a person reviews the permissions there. The deployment config is read (secrets as set or not) and written here, its
 * secrets entered by the person in a secure input request (platform web parity spec §4).
 */
@Injectable()
export class ExtensionsAdminOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ExtensionAdmin) private readonly admin: ExtensionAdmin,
    @Inject(ExtensionAdminOps) private readonly ops: ExtensionAdminOps,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(ExtensionDeploymentConfigService)
    private readonly deploymentConfigs: ExtensionDeploymentConfigService,
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    @Inject(PluginGuides) private readonly guides: Pick<PluginGuides, "deploymentGuides">,
    @Inject(SetupChecksService)
    private readonly checks: Pick<SetupChecksService, "deploymentStates" | "deploymentRun">,
    @Inject(LoginSourcesService)
    private readonly loginSources: Pick<LoginSourcesService, "providesIdentitySource">,
  ) {}

  /** The view of `name` for a precheck, or the refusal (unknown, startup-declared). */
  private async viewFor(
    name: string,
    orgId: string,
  ): Promise<{ ok: true; view: AdminExtensionView } | Exclude<PrecheckResult, { ok: true }>> {
    if ((await otherOrgExtensions(this.kdb.db, orgId, [name])).has(name)) {
      return { ok: false, code: "extension.not_found", message: OTHER_ORG };
    }
    let view: AdminExtensionView | undefined;
    const r = await precheckBy(async () => {
      view = await this.admin.get(name, { allowUnreadable: true });
    });
    if (!r.ok) return r;
    const v = view as AdminExtensionView;
    if (v.source === "config") {
      return {
        ok: false,
        code: "extension.config_declared",
        message: `Extension ${name} is declared in the startup config`,
      };
    }
    return { ok: true, view: v };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "extensions.platform-list",
        description:
          "List the extensions on the platform (super admin), one compact row each: the deployment status (enabled, disabled, pending_approval, pending_config, pending_migration, converging, failed, dependency, conflict), why one does not run (reason) and your next step (next), its version, how many orgs have it on and whether it is required. Extensions only other orgs' own plugins bring are counted (otherOrgExtensions), never listed. Details come from extensions.platform-get. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/extensions"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const theirs = await otherOrgExtensions(this.kdb.db, ctx.orgId);
          const all = (await this.admin.list()).filter((v) => !theirs.has(v.name));
          return {
            ...pageOf(all.map(row), startOf(input.cursor), 50),
            otherOrgExtensions: theirs.size,
            drainSeconds: this.config.get().extensionHost.drainSeconds,
          };
        },
      }),
      defineOperation({
        id: "extensions.pending-permissions",
        description:
          "List what waits for a super admin to confirm extension permissions (super admin): extensions whose permissions changed since they were approved (state pending_approval, with the permission keys added and removed and whether they are sensitive) and catalog plugins waiting for a confirmation, including this org's uploads with an extension. State and permission keys only, never config values. Other orgs' own plugins are only counted (otherOrgItems, otherOrgExtensions). Confirming is done by you in the admin console. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: [],
        confirm: "read",
        run: async (input, ctx) => {
          const [all, items, theirs] = await Promise.all([
            this.admin.list(),
            this.catalog.list({ pending: true }),
            otherOrgExtensions(this.kdb.db, ctx.orgId),
          ]);
          const waiting = all.filter((v) => v.status === "pending_approval");
          const exts = waiting.filter((v) => !theirs.has(v.name));
          const ours = items.filter(
            (i) => i.owner.kind === "platform" || i.owner.orgId === ctx.orgId,
          );
          return {
            ...pageOf(
              [...exts.map(pendingExtension), ...ours.map(pendingPlugin)],
              startOf(input.cursor),
              50,
            ),
            otherOrgItems: items.length - ours.length,
            otherOrgExtensions: waiting.length - exts.length,
          };
        },
        handoff: (_i, result) => {
          const r = result as {
            items?: { kind?: unknown; id?: unknown }[];
            total?: unknown;
          } | null;
          const rows = r?.items;
          if (rows === undefined || rows.length === 0) return null;
          // the one extension's page only when the whole waiting set is that extension
          const onlyExtension =
            r?.total === 1 && rows.length === 1 && rows[0]?.kind === "extension";
          const id = rows[0]?.id;
          return {
            kind: "handoff",
            title: {
              zh: "审阅待确认的权限",
              en: "Review the permissions waiting for confirmation",
            },
            target: {
              type: "link",
              url:
                onlyExtension && typeof id === "string"
                  ? `/admin/extensions/${encodeURIComponent(id)}`
                  : "/admin/plugins/pending",
            },
          };
        },
      }),
      defineOperation({
        id: "extensions.upload-package",
        description:
          "Store an extension package in the deployment's package store (super admin): a .tgz extension package of this conversation, e.g. one you packed in the sandbox and delivered with Deliver, passed as file: { fileId }; at most the deployment's package limit. Returns its review: name, version, sha256, the permissions it asks for and those added or removed against the approved ones, migration warnings. Nothing is installed or run. No web page shows a stored package: the person installs the stored package with the super admin API (`POST /api/v1/admin/extensions/:name/install` with `{ sha256 }` from the review), or with the capybara CLI (`capybara extensions install <file.tgz>`, which shows the permission review and asks them to confirm) after downloading the .tgz from this conversation.",
        input: z.object({ file: FileRefSchema }).strict(),
        example: { file: { fileId: "0b9f2c4e-1d3a-4c55-9e0a-7a2f6d1c8b11" } },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/extensions/packages/file"],
        // the route's raw body
        extras: ["file"],
        confirm: "platform",
        errors: [
          {
            code: "extension.package_invalid",
            next: "The package is not a valid extension package (the details list each problem); fix it, pack and deliver it again.",
          },
          {
            code: "extension.package_too_large",
            next: "The package is over the deployment's package limit; make it smaller.",
          },
          {
            code: "extension.config_declared",
            next: "An extension of this name is declared in the startup config; tell the person, who removes it there first.",
          },
          {
            code: "extension.name_conflict",
            next: "An extension of this name is installed from another npm package; check the package name.",
          },
        ],
        fileRef: (i) => ({
          ref: i.file,
          // the route takes the raw bytes whatever their type (a delivered .tgz is
          // application/octet-stream); the package reader checks them
          limits: { maxBytes: this.config.get().packages.maxBytes },
        }),
        summary: (_i, ctx) => {
          const f = named(ctx.file?.name ?? "?");
          return {
            zh: `把扩展包「${f}」存入平台的包存储（尚未安装）`,
            en: `Store the extension package "${f}" in the platform's package store (nothing is installed yet)`,
          };
        },
        run: async (_input, ctx) => {
          const f = ctx.file;
          if (f === undefined) throw new Error("extensions.upload-package: the file is missing");
          const r = await this.installs.ingestFile(ctx.actorAccountId, f.bytes, {
            auditDetail: viaAgent("extensions.upload-package", ctx),
          });
          return {
            review: {
              name: r.name,
              version: r.version,
              sha256: r.sha256,
              permissions: r.permissions,
              addedPermissions: r.added,
              removedPermissions: r.removed,
              warnings: r.warnings,
            },
            next: `Nothing is installed yet; the web has no page for a stored package. Tell the person to install it with the super admin API: POST /api/v1/admin/extensions/${r.name}/install with { "sha256": "${r.sha256}" }; or with \`capybara extensions install <file.tgz>\` (it shows the permission review and asks for confirmation) after downloading the .tgz from this conversation.`,
          };
        },
        noHandoff:
          "No web page shows a stored package; the person installs it and confirms its permissions with the super admin API or the capybara CLI.",
      }),
      defineOperation({
        id: "extensions.platform-get",
        description:
          "Read one extension on the platform (super admin): status with the reason and your next step, each replica's last report, its permissions and what changed since they were approved, whether its deployment config is valid (never the values), scope and how many orgs have it on.",
        input: NameInput,
        example: EXAMPLE,
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/extensions/:name"],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
          {
            code: "extension.package_unavailable",
            next: "Its package cannot be read on the platform; the admin console shows why, where it can be reinstalled.",
          },
        ],
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          return detail(await this.admin.get(input.name));
        },
      }),
      defineOperation({
        id: "extensions.platform-enable",
        description:
          "Enable an installed extension on the platform (super admin): every replica loads it, without a restart. It runs once its permissions are approved (on the web) and its deployment config is valid (extensions.platform-config, extensions.platform-set-config); orgs then switch it on themselves.",
        input: NameInput,
        example: EXAMPLE,
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/extensions/:name/enable"],
        confirm: "platform",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
          {
            code: "extension.config_declared",
            next: "This extension is declared in the startup config (extensions list): the deployment's config changes it, then a restart.",
          },
          {
            code: "extension.single_provider_enabled",
            next: "Only one extension may provide this extension point and another one is enabled: disable that one first (extensions.platform-disable, named in the error's details), then enable this one.",
          },
          {
            code: "extension.single_provider_required",
            next: "A required plugin of this deployment provides this extension point; it cannot be disabled, so this extension cannot replace it. Tell the user; there is nothing to retry.",
          },
        ],
        precheck: async (i, ctx) => {
          const r = await this.viewFor(i.name, ctx.orgId);
          if (!r.ok) return r;
          const block = r.view.enableBlocked;
          return block === undefined
            ? { ok: true }
            : {
                ok: false,
                code: block.required === true ? SINGLE_PROVIDER_REQUIRED : SINGLE_PROVIDER_ENABLED,
                message: singleProviderMessage(block, r.view.name, r.view.displayName),
              };
        },
        summary: async (i) => {
          const v = await this.admin.get(i.name, { allowUnreadable: true });
          const n = localized(v.displayName, v.name);
          return {
            zh: `在平台上启用扩展「${n.zh}」${v.version}`,
            en: `Enable extension "${n.en}" ${v.version} on the platform`,
          };
        },
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          const v = await this.ops.enable(
            input.name,
            ctx.actorAccountId,
            undefined,
            undefined,
            viaAgent("extensions.platform-enable", ctx),
          );
          return {
            extension: row(v),
            next: "Replicas load it in the background; check its state with extensions.platform-get.",
          };
        },
        handoff: (input, result) => {
          const state = (result as { extension?: { state?: unknown } } | null)?.extension?.state;
          if (state !== "pending_approval") return null;
          return {
            kind: "handoff",
            title: {
              zh: "审阅并确认扩展的权限",
              en: "Review and confirm the extension's permissions",
            },
            target: { type: "link", url: `/admin/extensions/${encodeURIComponent(input.name)}` },
          };
        },
      }),
      defineOperation({
        id: "extensions.platform-disable",
        description:
          "Disable an extension on the platform (super admin): every replica unloads it after draining in-flight calls, and extensions that require it unload too. The orgs' switches are kept; it is unavailable in every org until enabled again.",
        input: NameInput,
        example: EXAMPLE,
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/extensions/:name/disable"],
        confirm: "platform",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
          {
            code: "extension.config_declared",
            next: "This extension is declared in the startup config (extensions list): the deployment's config changes it, then a restart.",
          },
          {
            code: "extension.required",
            next: "A required extension shipped with the platform cannot be disabled or uninstalled.",
          },
        ],
        precheck: async (i, ctx) => {
          const r = await this.viewFor(i.name, ctx.orgId);
          if (!r.ok) return r;
          return r.view.required
            ? { ok: false, code: "extension.required", message: `Extension ${i.name} is required` }
            : { ok: true };
        },
        summary: async (i) => {
          const v = await this.admin.get(i.name, { allowUnreadable: true });
          const n = localized(v.displayName, v.name);
          const s = this.config.get().extensionHost.drainSeconds;
          return {
            zh: `在平台上停用扩展「${n.zh}」：${v.enabledOrgs} 个组织中不再可用（在途调用最多等待 ${s} 秒）`,
            en: `Disable extension "${n.en}" on the platform: unavailable in the ${v.enabledOrgs} orgs that have it on (in-flight calls drain up to ${s}s)`,
          };
        },
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          const v = await this.ops.disable(
            input.name,
            ctx.actorAccountId,
            undefined,
            undefined,
            viaAgent("extensions.platform-disable", ctx),
          );
          return { extension: row(v) };
        },
      }),
      defineOperation({
        id: "extensions.uninstall",
        description:
          "Uninstall a disabled extension from the platform (super admin; disable it first with extensions.platform-disable). Its data, secrets, org configs and approved permissions are kept, so reinstalling picks them up.",
        input: NameInput,
        example: EXAMPLE,
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/extensions/:name"],
        confirm: "platform",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
          {
            code: "extension.config_declared",
            next: "This extension is declared in the startup config (extensions list): the deployment's config changes it, then a restart.",
          },
          {
            code: "extension.required",
            next: "A required extension shipped with the platform cannot be disabled or uninstalled.",
          },
          {
            code: "extension.not_disabled",
            next: "Disable it first with extensions.platform-disable, then uninstall.",
          },
        ],
        precheck: async (i, ctx) => {
          const r = await this.viewFor(i.name, ctx.orgId);
          if (!r.ok) return r;
          if (r.view.required) {
            return {
              ok: false,
              code: "extension.required",
              message: `Extension ${i.name} is required`,
            };
          }
          if (r.view.desired?.state !== "disabled") {
            return {
              ok: false,
              code: "extension.not_disabled",
              message: `Extension ${i.name} is enabled; disable it before uninstalling`,
            };
          }
          return { ok: true };
        },
        summary: async (i) => {
          const v = await this.admin.get(i.name, { allowUnreadable: true });
          const n = localized(v.displayName, v.name);
          return {
            zh: `从平台卸载扩展「${n.zh}」${v.version}（数据与配置保留）`,
            en: `Uninstall extension "${n.en}" ${v.version} from the platform (its data and config are kept)`,
          };
        },
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          await this.ops.uninstall(
            input.name,
            ctx.actorAccountId,
            undefined,
            undefined,
            viaAgent("extensions.uninstall", ctx),
          );
          return { uninstalled: input.name };
        },
      }),
      defineOperation({
        id: "extensions.platform-config",
        description:
          "Read an extension's deployment config (super admin): each field's source (env, file or nacos: read-only here; db: saved here; default; unset), the effective value of non-secret fields, whether each secret field is set (never its value), the form's JSON Schema (secret fields carry x-secret), whether the config is valid and the problems (paths only), the overridable fields every org must fill in itself (orgMustConfigure), and the platform setup guides the extension ships (guides: id and title in locale, the person's language; read them with extensions.platform-guides). next names that operation when a guide exists and the config needs setting up.",
        input: NameInput.extend(DeploymentGuidesQuery.shape).strict(),
        example: { name: "slack", locale: "en" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/extensions/:name/config"],
        extras: ["locale"],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
        ],
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          const [view, guides, login] = await Promise.all([
            this.deploymentConfigs.view(input.name),
            this.guides.deploymentGuides(input.name, { locale: input.locale }),
            this.loginSources.providesIdentitySource(input.name),
          ]);
          const setup = configGuides(view, guides);
          // a login extension's sign-in switch is not part of its config (login extensions §3)
          const loginNext = login
            ? "Its sign-in is turned on and its trusted tenants set with login-sources.update."
            : undefined;
          const next = [setup.next, loginNext].filter((s) => s !== undefined).join(" ");
          return { ...view, ...setup, ...(next ? { next } : {}) };
        },
      }),
      defineOperation({
        id: "extensions.platform-set-config",
        description:
          "Save fields of an extension's deployment config (super admin): values maps field dot paths to new values (null clears a non-secret field; a field left out keeps its value). Secret fields are never in values: list them in askPerson and the person types them in a secure input request (on the web); list stored secrets to empty in clearSecrets. Required secrets without a stored value are asked even when not listed. Every replica applies the saved config without a restart. Read the fields first with extensions.platform-config.",
        input: z
          .object({
            name: Name,
            values: ConfigValues.default({}),
            askPerson: personFieldParams.askPerson,
            clearSecrets: personFieldParams.clearSecrets,
          })
          .strict(),
        example: { name: "model-anthropic", values: {}, askPerson: ["apiKey"], clearSecrets: [] },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/extensions/:name/config"],
        // secret record entries are entered on the web page (ruling R1)
        omits: ["secretEntries"],
        extras: ["askPerson", "clearSecrets"],
        loosens: {
          values: "defaults to {} so a call that only asks the person for secrets needs no values",
        },
        confirm: "platform",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
          {
            code: "extension.config_invalid",
            next: "Read the fields and their schema with extensions.platform-config, correct the values (the error's details name the fields), then call again.",
          },
          {
            code: "extension.config_readonly",
            next: "These fields come from the startup config (file, Nacos or environment): only the deployment's config changes them. Leave them out and call again.",
          },
        ],
        personFields: async (i, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, i.name, ctx.orgId);
          return deploymentPersonFields(
            await this.deploymentConfigs.view(i.name),
            [...i.askPerson, ...i.clearSecrets],
            i.values,
          );
        },
        summary: async (i, ctx) => {
          const v = await this.deploymentConfigs.view(i.name);
          const n = localized(v.displayName, v.plugin);
          const c = configChanges(i, ctx);
          return {
            zh: `保存扩展「${n.zh}」的平台部署配置：${c.zh}`,
            en: `Save the platform deployment config of extension "${n.en}": ${c.en}`,
          };
        },
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          const view = await withPersonInputs(
            "extensions.platform-set-config",
            ctx,
            (entered, detail) =>
              this.deploymentConfigs.put(
                input.name,
                flatValues(input.values, entered, input.clearSecrets),
                ctx.actorAccountId,
                undefined,
                [],
                detail,
              ),
          );
          return {
            config: view,
            next: "Replicas apply it in the background; check the extension's state with extensions.platform-get.",
          };
        },
      }),
      defineOperation({
        id: "extensions.platform-clear-config",
        description:
          "Clear the deployment config saved on the platform for an extension (super admin): every saved field and every stored secret. Fields from the startup config (file, Nacos, environment) stay in effect. The extension reloads from what remains, or waits for configuration when that is missing or invalid.",
        input: NameInput,
        example: EXAMPLE,
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/extensions/:name/config"],
        confirm: "platform",
        rememberable: false,
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
        ],
        summary: async (i) => {
          const v = await this.deploymentConfigs.view(i.name);
          const n = localized(v.displayName, v.plugin);
          return {
            zh: `清除扩展「${n.zh}」保存在平台上的部署配置（含全部密钥；启动配置中的字段保留）`,
            en: `Clear the deployment config of extension "${n.en}" saved on the platform (every secret too; startup config fields stay)`,
          };
        },
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          const view = await this.deploymentConfigs.clear(
            input.name,
            ctx.actorAccountId,
            undefined,
            viaAgent("extensions.platform-clear-config", ctx),
          );
          return { config: view };
        },
      }),
      defineOperation({
        id: "extensions.platform-guides",
        description:
          "Read an extension's platform setup guides (super admin): the guides it ships for its deployment config (for example a push provider's credentials), rendered with the steps and the checks as check rows (run them with extensions.platform-check). Secrets are never in a guide: the person types each one into the deployment config form in the admin console (Extensions → the extension), or in the secure input request of extensions.platform-set-config. Empty when the extension ships none.",
        input: DeploymentGuidesPathParams.extend(DeploymentGuidesQuery.shape).strict(),
        example: { name: "push-apns" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/extensions/:name/guides"],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
        ],
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          return { guides: await this.guides.deploymentGuides(input.name, input) };
        },
        handoff: (input) => ({
          kind: "handoff",
          title: {
            zh: "在扩展页面填写部署配置",
            en: "Fill in the deployment config on the extension page",
          },
          target: { type: "link", url: `/admin/extensions/${encodeURIComponent(input.name)}` },
        }),
      }),
      defineOperation({
        id: "extensions.platform-check-status",
        description:
          "Read the cached state of every check of an extension's platform setup guide, by check id: ok, failing, unknown, running or not_run, with the reason and fix to show the person. Runs nothing; run a check with extensions.platform-check.",
        input: DeploymentGuidePathParams.strict(),
        example: { name: "push-apns", guideId: "apns-key" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/extensions/:name/guides/:guideId/checks"],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
          {
            code: "catalog.guide_not_found",
            next: "The extension has no platform setup guide with that id; list them with extensions.platform-guides.",
          },
        ],
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          return {
            results: await this.checks.deploymentStates(
              ctx.actorAccountId,
              input.name,
              input.guideId,
            ),
          };
        },
      }),
      defineOperation({
        id: "extensions.platform-check",
        description:
          "Run one check of an extension's platform setup guide against its deployment config and return its state: ok, failing (with a reason and a fix to explain), unknown, or running (try again in a moment). A fresh cached result is returned as is; force reruns it, at most once per 10 seconds per check. A check only reads; run it after the person says they saved the config. The result is shown to you: the kernel redacts exact matches of whole secret values of 8 characters or more, so a well-behaved check never echoes any part of a secret, and you never repeat a value that looks like one.",
        input: DeploymentCheckPathParams.extend(DeploymentCheckRunBody.shape).strict(),
        example: { name: "push-apns", guideId: "apns-key", checkId: "key-works" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/extensions/:name/guides/:guideId/checks/:checkId/run"],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension name with extensions.platform-list.",
          },
          {
            code: "catalog.guide_not_found",
            next: "The extension has no platform setup guide with that id; list them with extensions.platform-guides.",
          },
          {
            code: "catalog.check_not_found",
            next: "That check is not in the guide; read the check ids with extensions.platform-check-status.",
          },
          {
            code: "rate_limited",
            next: "This person ran 30 checks in the last minute; wait a minute before running another, and read the cached states with extensions.platform-check-status meanwhile.",
          },
        ],
        run: async (input, ctx) => {
          await assertExtensionNotOtherOrgs(this.kdb.db, input.name, ctx.orgId);
          const { name, guideId, checkId, ...body } = input;
          return {
            result: await this.checks.deploymentRun(
              ctx.actorAccountId,
              name,
              guideId,
              checkId,
              body,
            ),
          };
        },
      }),
    ]);
  }
}
