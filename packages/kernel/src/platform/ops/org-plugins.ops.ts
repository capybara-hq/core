import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AppearanceService } from "../../catalog/appearance.service.js";
import { CatalogScopeService } from "../../catalog/catalog-scope.service.js";
import { PluginInstallPathParams } from "../../catalog/org-catalog.schemas.js";
import { OrgCatalogService } from "../../catalog/org-catalog.service.js";
import { OrgExtensionParams } from "../../catalog/org-extension.schemas.js";
import { OrgPluginUploads } from "../../catalog/org-plugin-uploads.js";
import {
  OrgOwnedDeleteBody,
  OrgOwnedPluginParams,
  OrgOwnedShareableBody,
  OrgUploadStagingParams,
} from "../../catalog/org-plugin-uploads.schemas.js";
import { OwnedItems } from "../../catalog/owned-items.js";
import { PluginInstaller, type PluginInstallView } from "../../catalog/plugin-install.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { ThemesService } from "../../themes/themes.service.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { appearanceSummary, reviewBrief } from "./catalog-admin.ops.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { localized, named, orElse } from "./summary.js";

const InstallId = PluginInstallPathParams.shape.installId.max(100);
/** An org-owned plugin's catalog item id (`:id` of the owned-plugins routes). */
const OwnedId = OrgOwnedPluginParams.shape.id;
const EXAMPLE_ID = "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c";

/** One of the org's plugin installs as `plugins.installs` shows it: a compact row. */
const installRow = (i: PluginInstallView) => ({
  id: i.id,
  name: i.name,
  state: i.status,
  ...(i.error !== null && { reason: `${i.error.step}: ${i.error.code}` }),
  itemId: i.itemId,
  version: i.version,
  components: i.components.length,
});

/**
 * The org's own plugin operations of the `Platform` tool (spec §14.2): the org's plugin installs
 * (list, uninstall), its staged uploads (read; uploading is a byte transport and confirming is done
 * by a person on the web), and the plugins it owns (share, delete after a preview, withdraw a
 * pending upload). Org admins; the services re-check the role under the org lock.
 */
@Injectable()
export class OrgPluginsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    @Inject(OrgCatalogService) private readonly orgCatalog: OrgCatalogService,
    @Inject(OrgPluginUploads) private readonly uploads: OrgPluginUploads,
    @Inject(OwnedItems) private readonly owned: OwnedItems,
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(AppearanceService) private readonly appearance: AppearanceService,
    @Inject(ThemesService) private readonly themes: ThemesService,
  ) {}

  /** The display name of the live plugin of `extension`, or the name when it cannot be read. */
  private pluginNames(extension: string): Promise<{ zh: string; en: string }> {
    return orElse(
      async () => {
        const row = await this.kdb.db
          .selectFrom("catalog_items")
          .select("display_name")
          .where("name", "=", extension)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        return localized(row?.display_name, extension);
      },
      { zh: named(extension), en: named(extension) },
    );
  }

  /** The org's own live plugin `id`, or null (another org's, a platform one, deleted, unknown). */
  private async ownedItem(orgId: string, id: string) {
    const row = await this.kdb.db
      .selectFrom("catalog_items")
      .select(["id", "name", "shareable", "awaiting_confirmation", "pending_version"])
      .where("id", "=", id)
      .where("owner_org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst()
      .catch(() => undefined);
    return row ?? null;
  }

  /** The precheck refusal of a plugin the org does not own. */
  private async ownedPrecheck(orgId: string, id: string): Promise<PrecheckResult> {
    return (await this.ownedItem(orgId, id)) === null
      ? { ok: false, code: "catalog.item_not_found", message: "Catalog item not found" }
      : { ok: true };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "plugins.installs",
        description:
          "List the plugin installs of this org (org admins), one compact row each: the plugin, the install state (installing, installed, failed, uninstalling, upgrading), a failure's step and code (reason), the version and how many components it brought. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/plugin-installs"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) =>
          pageOf((await this.installer.list(ctx.orgId)).map(installRow), startOf(input.cursor), 50),
      }),
      defineOperation({
        id: "plugins.uninstall",
        description:
          "Uninstall one plugin install from this org (org admins): removes the components it brought (agents using them lose them). Usually switch the plugin off with plugins.set-enabled instead; this one also cleans up a failed or stuck install.",
        input: z.object({ installId: InstallId }).strict(),
        example: { installId: EXAMPLE_ID },
        // the route needs org.extensions.manage; the service re-checks the plugin's component actions
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/plugin-installs/:installId"],
        confirm: "org",
        errors: [
          { code: "plugin.install_not_found", next: "Check the install id with plugins.installs." },
          {
            code: "plugin.scope_locked",
            next: "The plugin is on for every org (or built in) and cannot be uninstalled in one org.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.installer.previewUninstall(ctx.orgId, i.installId)),
        summary: async (i, ctx) => {
          const p = await this.installer.previewUninstall(ctx.orgId, i.installId);
          return {
            zh: `从本组织卸载插件「${named(p.name)}」${p.version}：移除 ${p.components.length} 个组件，${p.agents.length} 个智能体在用`,
            en: `Uninstall plugin "${named(p.name)}" ${p.version} from the org: removes ${p.components.length} components; ${p.agents.length} agents use it`,
          };
        },
        run: async (input, ctx) =>
          this.orgCatalog.uninstall(
            ctx.orgId,
            ctx.actorAccountId,
            input.installId,
            undefined,
            viaAgent("plugins.uninstall", ctx),
          ),
      }),
      defineOperation({
        id: "plugins.upload-review",
        description:
          "Read one of this org's staged plugin uploads (org admins): what the plugin brings, and for a new version of the org's own plugin the update it applies. Uploading the package and confirming it are done by a person on the web (插件 page).",
        input: z.object({ stagingId: OrgUploadStagingParams.shape.stagingId }).strict(),
        example: { stagingId: EXAMPLE_ID },
        authz: { orgAction: "catalog.upload" },
        mirrors: ["GET /api/v1/orgs/:orgId/catalog/uploads/:stagingId"],
        confirm: "read",
        errors: [
          {
            code: "plugin.staging_not_found",
            next: "The staged upload expired (24 hours), was confirmed, or is not this org's; the person uploads it again on the 插件 page.",
          },
        ],
        run: async (input, ctx) => {
          const r = await this.uploads.staged(ctx.orgId, input.stagingId);
          return {
            stagingId: r.stagingId,
            review: reviewBrief(r.review),
            update:
              r.update === null
                ? null
                : {
                    from: r.update.from,
                    to: r.update.to,
                    components: r.update.components.filter((c) => c.change !== "same").length,
                  },
            next: "The person confirms the upload on the web (插件 page).",
          };
        },
      }),
      defineOperation({
        id: "plugins.set-shareable",
        description:
          "Share one of this org's own plugins with other orgs, or stop sharing it (org admins). Stopping keeps the orgs that already use it and hides it from new ones; the super admin decides where a shared plugin is offered.",
        input: z.object({ itemId: OwnedId, ...OrgOwnedShareableBody.shape }).strict(),
        example: { itemId: EXAMPLE_ID, shareable: true },
        authz: { orgAction: "catalog.upload" },
        mirrors: ["PUT /api/v1/orgs/:orgId/owned-plugins/:id/shareable"],
        renames: { itemId: "id" },
        confirm: "org",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Only the org's own uploaded plugins qualify; check the id with plugins.list (owner: this org).",
          },
          {
            code: "catalog.item_pending",
            next: "The plugin's first version waits for the super admin's confirmation; share it once it is confirmed.",
          },
        ],
        precheck: (i, ctx) => this.ownedPrecheck(ctx.orgId, i.itemId),
        summary: async (i, ctx) => {
          const name = named((await this.ownedItem(ctx.orgId, i.itemId))?.name ?? i.itemId);
          return i.shareable
            ? {
                zh: `把本组织的插件「${name}」设为可共享`,
                en: `Share the org's plugin "${name}" with other orgs`,
              }
            : {
                zh: `停止共享本组织的插件「${name}」`,
                en: `Stop sharing the org's plugin "${name}"`,
              };
        },
        run: async (input, ctx) => {
          await this.owned.setShareable(
            ctx.orgId,
            ctx.actorAccountId,
            { kind: "plugin", id: input.itemId },
            input.shareable,
            { auditDetail: viaAgent("plugins.set-shareable", ctx) },
          );
          return { itemId: input.itemId, shareable: input.shareable };
        },
      }),
      defineOperation({
        id: "plugins.owned-delete-preview",
        description:
          "Preview deleting one of this org's own plugins (org admins): removed, or transferred to the platform when other orgs use it (those orgs), the org's agents that lose it, and the previewHash plugins.owned-delete needs. Nothing is written; show it to the person first.",
        input: z.object({ itemId: OwnedId }).strict(),
        example: { itemId: EXAMPLE_ID },
        authz: { orgAction: "catalog.upload" },
        mirrors: ["POST /api/v1/orgs/:orgId/owned-plugins/:id/delete/preview"],
        renames: { itemId: "id" },
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Only the org's own uploaded plugins qualify; check the id with plugins.list (owner: this org).",
          },
        ],
        run: async (input, ctx) => this.owned.previewDelete(ctx.orgId, input.itemId),
      }),
      defineOperation({
        id: "plugins.owned-delete",
        description:
          "Delete one of this org's own plugins after its preview (org admins): pass the previewHash plugins.owned-delete-preview returned. It is removed, or transferred to the platform when other orgs use it; a preview that is out of date is refused.",
        input: z.object({ itemId: OwnedId, ...OrgOwnedDeleteBody.shape }).strict(),
        example: {
          itemId: EXAMPLE_ID,
          previewHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        authz: { orgAction: "catalog.upload" },
        mirrors: ["POST /api/v1/orgs/:orgId/owned-plugins/:id/delete"],
        renames: { itemId: "id" },
        confirm: "org",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Only the org's own uploaded plugins qualify; check the id with plugins.list (owner: this org).",
          },
          {
            code: "catalog.preview_stale",
            next: "Call plugins.owned-delete-preview again, show it, and call again with the new previewHash.",
          },
        ],
        precheck: async (i, ctx) => {
          let hash = "";
          const r = await precheckBy(async () => {
            hash = (await this.owned.previewDelete(ctx.orgId, i.itemId)).previewHash;
          });
          if (!r.ok) return r;
          return hash === i.previewHash
            ? { ok: true }
            : {
                ok: false,
                code: "catalog.preview_stale",
                message: "What deleting this plugin does has changed since the preview",
              };
        },
        summary: async (i, ctx) => {
          const [row, p] = await Promise.all([
            this.ownedItem(ctx.orgId, i.itemId),
            this.owned.previewDelete(ctx.orgId, i.itemId),
          ]);
          const name = named(row?.name ?? i.itemId);
          return p.outcome === "transferred"
            ? {
                zh: `删除本组织的插件「${name}」：${p.orgs.length} 个其他组织在用，转交平台；本组织 ${p.agents.length} 个智能体失去它`,
                en: `Delete the org's plugin "${name}": ${p.orgs.length} other orgs use it, so it moves to the platform; ${p.agents.length} agents here lose it`,
              }
            : {
                zh: `删除本组织的插件「${name}」：${p.agents.length} 个智能体失去它`,
                en: `Delete the org's plugin "${name}": ${p.agents.length} agents lose it`,
              };
        },
        run: async (input, ctx) => {
          await this.owned.delete(ctx.orgId, ctx.actorAccountId, input.itemId, input.previewHash, {
            auditDetail: viaAgent("plugins.owned-delete", ctx),
          });
          return { deleted: input.itemId };
        },
      }),
      defineOperation({
        id: "plugins.withdraw-upload",
        description:
          "Withdraw this org's upload of one of its plugins that waits for the super admin (org admins): a first version is removed (its name is free again); a new version's pending state is cleared and the current version keeps running.",
        input: z.object({ itemId: OwnedId }).strict(),
        example: { itemId: EXAMPLE_ID },
        authz: { orgAction: "catalog.upload" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/owned-plugins/:id/pending"],
        renames: { itemId: "id" },
        confirm: "org",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Only the org's own uploaded plugins qualify; check the id with plugins.list (owner: this org).",
          },
          {
            code: "extension.not_pending",
            next: "Nothing of this plugin waits for the super admin; there is nothing to withdraw.",
          },
        ],
        precheck: async (i, ctx) => {
          const row = await this.ownedItem(ctx.orgId, i.itemId);
          if (row === null) {
            return { ok: false, code: "catalog.item_not_found", message: "Catalog item not found" };
          }
          return row.awaiting_confirmation || row.pending_version !== null
            ? { ok: true }
            : {
                ok: false,
                code: "extension.not_pending",
                message: `Plugin ${row.name} has no upload waiting for the super admin`,
              };
        },
        summary: async (i, ctx) => {
          const row = await this.ownedItem(ctx.orgId, i.itemId);
          const name = named(row?.name ?? i.itemId);
          return row?.awaiting_confirmation
            ? {
                zh: `撤回本组织插件「${name}」待确认的首个版本（插件随之移除）`,
                en: `Withdraw the pending first version of the org's plugin "${name}" (the plugin is removed)`,
              }
            : {
                zh: `撤回本组织插件「${name}」待确认的新版本 ${row?.pending_version ?? ""}`,
                en: `Withdraw the pending new version ${row?.pending_version ?? ""} of the org's plugin "${name}"`,
              };
        },
        run: async (input, ctx) => {
          await this.scope.withdraw(ctx.orgId, ctx.actorAccountId, input.itemId, {
            auditDetail: viaAgent("plugins.withdraw-upload", ctx),
          });
          return { withdrawn: input.itemId };
        },
      }),
      defineOperation({
        id: "plugins.apply-appearance",
        description:
          "Apply a plugin's suggested appearance in this org (org admins; the 扩展 page's 应用此插件的外观), for a plugin whose extension is on here: in one step, its theme becomes the org's default theme (whether members may pick their own stays as it is) and each component it suggests replaces the built-in block of its slot (shell.brand, conversation.empty, conversation.composer.frame) in the org's arrangement. The card shows exactly what changes; a theme that is not on in the org refuses the whole call, a component that is not available is skipped. Asked every time, never remembered.",
        input: z.object({ extension: OrgExtensionParams.shape.extension }).strict(),
        example: { extension: "theme-cyberpunk" },
        authz: { orgAction: "org.update" },
        mirrors: ["POST /api/v1/orgs/:orgId/extensions/:extension/appearance"],
        // the route's dry run is this operation's card and precheck, never a confirmed call
        omits: ["dryRun"],
        confirm: "org",
        rememberable: false,
        errors: [
          {
            code: "extension.not_found",
            next: "Check the extension with extensions.list: it must be on in this org and its plugin must suggest an appearance.",
          },
          {
            code: "theme.not_available",
            next: {
              orgAdmin:
                "The plugin's theme is not on in this org: switch it on in the org's appearance settings on the web, or ask the super admin to offer it to this org, then apply again.",
              member: "Ask an org admin to switch the plugin's theme on in this org first.",
            },
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.appearance.apply(
              { orgId: ctx.orgId },
              i.extension,
              { accountId: ctx.actorAccountId },
              true,
            ),
          ),
        summary: async (i, ctx) => {
          const [n, r] = await Promise.all([
            this.pluginNames(i.extension),
            this.appearance.apply(
              { orgId: ctx.orgId },
              i.extension,
              { accountId: ctx.actorAccountId },
              true,
            ),
          ]);
          const theme =
            r.theme && localized(await this.themes.nameIn(ctx.orgId, r.theme.to), r.theme.to);
          return appearanceSummary("org", n, r, theme);
        },
        run: async (input, ctx) =>
          this.appearance.apply(
            { orgId: ctx.orgId },
            input.extension,
            {
              accountId: ctx.actorAccountId,
              auditDetail: viaAgent("plugins.apply-appearance", ctx),
            },
            false,
          ),
      }),
    ]);
  }
}
