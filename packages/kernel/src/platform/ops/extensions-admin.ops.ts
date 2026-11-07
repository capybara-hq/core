import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AdminExtensionNamePathParams } from "../../admin/extensions.schemas.js";
import { ExtensionAdminOps } from "../../extensions/admin-ops.js";
import { ExtensionAdmin } from "../../extensions/admin-view.js";
import type { AdminExtensionView } from "../../extensions/permission-view.js";
import { unavailableReason } from "../../extensions/unavailable.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
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
const why = (v: AdminExtensionView) =>
  v.status === "enabled"
    ? {}
    : unavailableFields(unavailableReason(v.status), enName(v), "superAdmin");

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
  ) {}

  /** The view of `name` for a precheck, or the refusal (unknown, startup-declared). */
  private async viewFor(
    name: string,
  ): Promise<{ ok: true; view: AdminExtensionView } | Exclude<PrecheckResult, { ok: true }>> {
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
          "List the extensions on the platform (super admin), one compact row each: the deployment status (enabled, disabled, pending_approval, pending_config, pending_migration, converging, failed, dependency, legacy_format), why one does not run (reason) and your next step (next), its version, how many orgs have it on and whether it is required. Details come from extensions.platform-get. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/extensions"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input) => ({
          ...pageOf((await this.admin.list()).map(row), startOf(input.cursor), 50),
          drainSeconds: this.config.get().extensionHost.drainSeconds,
        }),
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
        run: async (input) => detail(await this.admin.get(input.name)),
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
        ],
        precheck: async (i) => {
          const r = await this.viewFor(i.name);
          return r.ok ? { ok: true } : r;
        },
        summary: async (i) => {
          const v = await this.admin.get(i.name, { allowUnreadable: true });
          const n = localized(v.displayName, v.name);
          return {
            zh: `在平台上启用扩展「${n.zh}」${v.version}`,
            en: `Enable extension "${n.en}" ${v.version} on the platform`,
          };
        },
        run: async (input, ctx) => ({
          extension: row(
            await this.ops.enable(
              input.name,
              ctx.actorAccountId,
              undefined,
              undefined,
              viaAgent("extensions.platform-enable", ctx),
            ),
          ),
          next: "Replicas load it in the background; check its state with extensions.platform-get.",
        }),
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
        precheck: async (i) => {
          const r = await this.viewFor(i.name);
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
        run: async (input, ctx) => ({
          extension: row(
            await this.ops.disable(
              input.name,
              ctx.actorAccountId,
              undefined,
              undefined,
              viaAgent("extensions.platform-disable", ctx),
            ),
          ),
        }),
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
        precheck: async (i) => {
          const r = await this.viewFor(i.name);
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
