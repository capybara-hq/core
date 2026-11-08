import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AdminExtensionNamePathParams } from "../../admin/extensions.schemas.js";
import { type CatalogItemView, CatalogService } from "../../catalog/catalog.service.js";
import { ExtensionAdminOps } from "../../extensions/admin-ops.js";
import { ExtensionAdmin } from "../../extensions/admin-view.js";
import type { AdminExtensionView } from "../../extensions/permission-view.js";
import {
  SINGLE_PROVIDER_ENABLED,
  SINGLE_PROVIDER_REQUIRED,
  singleProviderMessage,
} from "../../extensions/single-provider.js";
import { unavailableReason } from "../../extensions/unavailable.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { assertExtensionNotOtherOrgs, OTHER_ORG, otherOrgExtensions } from "./other-orgs.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { localized } from "./summary.js";
import { unavailableFields } from "./unavailable.js";

/** An extension's name (`:name` of the admin routes), bounded like the org routes' `:extension`. */
const Name = AdminExtensionNamePathParams.shape.name.max(64);
const NameInput = z.object({ name: Name }).strict();
const EXAMPLE = { name: "model-anthropic" };

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
const CONFIRM_ON_WEB =
  "Review and confirm its permissions in the admin console; agents never confirm permissions.";

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
 * §14.5 item 1): the deployment's extensions (list, read), enable, disable and uninstall. Installing
 * a package (upload, npm) and approving permissions stay on the web: a person reviews the
 * permissions there. Deployment config is never read or written here (secrets).
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
          "List the extensions on the platform (super admin), one compact row each: the deployment status (enabled, disabled, pending_approval, pending_config, pending_migration, converging, failed, dependency, conflict, legacy_format), why one does not run (reason) and your next step (next), its version, how many orgs have it on and whether it is required. Extensions only other orgs' own plugins bring are counted (otherOrgExtensions), never listed. Details come from extensions.platform-get. Pages by 50: pass the returned next as params.cursor.",
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
          "List what waits for a super admin to confirm extension permissions (super admin): extensions whose permissions changed since they were approved (state pending_approval, with the permission keys added and removed and whether they are sensitive) and catalog plugins waiting for a confirmation, including this org's uploads with an extension. State and permission keys only, never config values. Other orgs' own plugins are only counted (otherOrgItems, otherOrgExtensions). Confirming is done by you in the admin console, never by an agent. Pages by 50: pass the returned next as params.cursor.",
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
          "Enable an installed extension on the platform (super admin): every replica loads it, without a restart. It runs once its permissions are approved and its deployment config is valid (both on the web); orgs then switch it on themselves.",
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
    ]);
  }
}
