import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { CatalogService } from "../../catalog/catalog.service.js";
import type { OrgCatalogItem } from "../../catalog/catalog-content.js";
import { OrgCatalogService } from "../../catalog/org-catalog.service.js";
import { PluginInstaller, uninstallPreviewHash } from "../../catalog/plugin-install.js";
import { PlatformPluginUpdater } from "../../catalog/plugin-upgrade.js";
import { OrgExtensionConfigs, type OrgExtensionView } from "../../extensions/org-config.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation } from "../operation.js";
import { redactOrgs } from "../redact-orgs.js";
import { PlatformOperations } from "../registry.js";
import { asToolError, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";

const Id = z.string().min(1).max(100);
const Version = z.string().min(1).max(100);
const Hash = z.string().min(1).max(200);

/** Entries per page of the paged lists (the tool caps a bare list at 50). */
const PAGE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OTHER_ORG = "This plugin belongs to another org; use the admin console.";
const LOCKED =
  "This plugin is on for every org (or shipped with the platform) and cannot be switched off in one org.";
/** The confirm value of switching off a plugin with nothing installed in the org. */
const NOTHING_INSTALLED = "nothing-installed";

export const NEEDS_INPUT =
  "This plugin needs configuration a person must enter; ask them to enable it on the 插件 page.";

/** An org's view of a plugin, as the list shows it. */
const brief = (i: OrgCatalogItem) => ({
  id: i.id,
  name: i.name,
  displayName: i.displayName,
  description: i.description,
  scope: i.scope,
  state: i.state,
  switchable: i.switchable,
  builtin: i.builtin,
  notDeployed: i.notDeployed,
  latestVersion: i.latestVersion,
  installedVersion: i.installed?.version ?? null,
  componentCounts: i.componentCounts,
  owner: i.owner,
  request: i.request,
});

const hasConfigFields = (schema: OrgExtensionView["orgConfigSchema"]): boolean => {
  const props = (schema as { properties?: unknown } | null)?.properties;
  return typeof props === "object" && props !== null && Object.keys(props).length > 0;
};

/**
 * Whether switching the plugin on needs input a person enters (the web's install wizard, the
 * web's `needsInput`): an org config still missing (`needs_config`), connector templates, or the
 * org config form of its extension while that extension is off in the org.
 */
function needsInput(item: OrgCatalogItem, extensions: readonly OrgExtensionView[]): boolean {
  if (item.state === "needs_config") return true;
  if (item.installed !== null) return false;
  if (item.componentCounts.connectorTemplates > 0) return true;
  if (item.componentCounts.extension === 0) return false;
  const own = extensions.find((e) => e.catalogItem?.itemId === item.id);
  return own !== undefined && !own.enabled && hasConfigFields(own.orgConfigSchema);
}

/**
 * Plugin operations of the `Platform` tool (spec §7): the org's view (list, get, switch on or off)
 * and the super admin's platform view (list, get, update with its preview). Every platform result
 * goes through {@link redactOrgs}: other orgs only as counts (spec §6.1).
 */
@Injectable()
export class PluginsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(OrgCatalogService) private readonly orgCatalog: OrgCatalogService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PlatformPluginUpdater) private readonly updater: PlatformPluginUpdater,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    @Inject(OrgExtensionConfigs) private readonly extensions: OrgExtensionConfigs,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /**
   * Refuses a super-admin operation on an item another org owns: its results would describe that
   * org's private plugin in this org's log (spec §6.1). Platform items and the org's own pass.
   */
  private async assertNotOtherOrgs(itemId: string, orgId: string): Promise<void> {
    if (!UUID_RE.test(itemId)) return;
    const row = await this.kdb.db
      .selectFrom("catalog_items")
      .select("owner_org_id")
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (row?.owner_org_id != null && row.owner_org_id !== orgId) throw new ToolError(OTHER_ORG);
  }

  /** How many live catalog items other orgs own (left out of the platform list). */
  private async otherOrgItems(orgId: string): Promise<number> {
    const r = await this.kdb.db
      .selectFrom("catalog_items")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("deleted_at", "is", null)
      .where("owner_org_id", "is not", null)
      .where("owner_org_id", "!=", orgId)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "plugins.list",
        description:
          "List the plugins this org can see, with their state here (on, off, needs_config, unavailable, not_offered), whether an org admin can switch them, and the org's pending request. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/catalog"],
        confirm: "read",
        run: async (input, ctx) => {
          const all = await this.orgCatalog.list(ctx.orgId, ctx.actorAccountId);
          return pageOf(all.map(brief), startOf(input.cursor), PAGE);
        },
      }),
      defineOperation({
        id: "plugins.get",
        description:
          "Read one plugin as this org sees it: its state, extension, connector templates (presets only, never credentials), dependencies, skills and agent templates.",
        input: z.object({ itemId: Id }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/catalog/:itemId"],
        confirm: "read",
        errors: [
          { code: "catalog.item_not_found", next: "Check the plugin id with plugins.list." },
        ],
        run: async (input, ctx) =>
          asToolError(async () => {
            const d = await this.orgCatalog.detail(ctx.orgId, ctx.actorAccountId, input.itemId);
            return { ...d, item: brief(d.item) };
          }),
      }),
      defineOperation({
        id: "plugins.disable-preview",
        description:
          "Preview switching a plugin off in this org (org admins): what it would remove and which agents use it, and the confirm value plugins.set-enabled needs to switch it off. Show the preview to the person before switching off.",
        input: z.object({ itemId: Id }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        // the web previews through the switch route itself (no confirm); writes nothing here
        authz: { orgAction: "org.extensions.manage" },
        mirrors: [],
        confirm: "read",
        errors: [
          { code: "catalog.item_not_found", next: "Check the plugin id with plugins.list." },
        ],
        run: async (input, ctx) =>
          asToolError(async () => {
            const d = await this.orgCatalog.detail(ctx.orgId, ctx.actorAccountId, input.itemId);
            if (!d.item.switchable) throw new ToolError(LOCKED);
            const live = d.item.installed;
            if (live === null) {
              return {
                preview: null,
                confirm: NOTHING_INSTALLED,
                next: "Nothing is installed in the org, so switching off removes nothing; pass this confirm value.",
              };
            }
            const preview = await this.installer.previewUninstall(ctx.orgId, live.pluginInstallId);
            return { preview, confirm: uninstallPreviewHash(preview) };
          }),
      }),
      defineOperation({
        id: "plugins.set-enabled",
        description:
          "Switch a plugin on or off in this org. Switching on installs it; a plugin whose enabling needs configuration a person enters (connector credentials, extension config) is refused, so point the person to the 插件 page. Switching off removes what the plugin brought and needs confirm: the value plugins.disable-preview returned with the preview the person saw.",
        input: z.discriminatedUnion("enabled", [
          z.object({ itemId: Id, enabled: z.literal(true) }).strict(),
          z.object({ itemId: Id, enabled: z.literal(false), confirm: Hash }).strict(),
        ]),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", enabled: true },
        // the route needs catalog.read; setSwitch requires an org admin (any of skills.manage,
        // connectors.manage, org.extensions.manage, all the admin role)
        authz: { orgAction: "org.extensions.manage" },
        authzNote: "service-enforced",
        mirrors: ["PUT /api/v1/orgs/:orgId/catalog/:itemId/switch"],
        confirm: "org",
        errors: [
          {
            code: "plugin.switch_stale",
            next: "The uninstall preview changed: call plugins.disable-preview again, show it, and call again with the new confirm value.",
          },
          {
            code: "plugin.scope_locked",
            next: "The plugin is on for every org and cannot be switched off in one org.",
          },
          {
            code: "plugin.disabled",
            next: "The super admin stopped this plugin on the platform; ask them.",
          },
          {
            code: "catalog.approval_required",
            next: "The plugin is not offered to this org: create an access request with requests.create.",
          },
          {
            code: "plugin.skill_conflict",
            next: "An org skill has the name of one of the plugin's skills; the person resolves it on the web.",
          },
        ],
        summary: (i) =>
          i.enabled
            ? { zh: `在本组织启用插件 ${i.itemId}`, en: `Enable plugin ${i.itemId} in the org` }
            : { zh: `在本组织停用插件 ${i.itemId}`, en: `Disable plugin ${i.itemId} in the org` },
        run: async (input, ctx) =>
          asToolError(async () => {
            if (input.enabled) {
              const [item] = await this.orgCatalog.list(
                ctx.orgId,
                ctx.actorAccountId,
                input.itemId,
              );
              if (item && needsInput(item, await this.extensions.list(ctx.orgId))) {
                throw new ToolError(NEEDS_INPUT);
              }
            }
            const r = await this.orgCatalog.setSwitch(
              ctx.orgId,
              ctx.actorAccountId,
              input.itemId,
              input.enabled ? { enabled: true } : { enabled: false, confirm: input.confirm },
              undefined,
              viaAgent("plugins.set-enabled", ctx),
            );
            if (r.kind === "done") return { item: brief(r.item) };
            // unreachable: confirm is required when switching off
            return { preview: r.preview, confirm: r.confirm };
          }),
      }),
      defineOperation({
        id: "plugins.platform-list",
        description:
          "List the platform's plugins and this org's own (super admin): scope, disabled, versions, pending confirmation and how many orgs use it. Plugins other orgs own are only counted (otherOrgItems); orgs are given as counts. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/catalog/items"],
        confirm: "read",
        run: async (input, ctx) => {
          const p = await this.catalog.page({ limit: PAGE, offset: startOf(input.cursor) });
          return redactOrgs({
            items: p.items.filter((i) => i.owner.kind !== "org" || i.owner.orgId === ctx.orgId),
            otherOrgItems: await this.otherOrgItems(ctx.orgId),
            next: p.nextOffset === null ? null : String(p.nextOffset),
          });
        },
      }),
      defineOperation({
        id: "plugins.platform-get",
        description:
          "Read one platform catalog plugin (super admin): the item, its platform version and every version with its source. Orgs are given as counts only.",
        input: z.object({ itemId: Id }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/catalog/items/:id"],
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id with plugins.platform-list.",
          },
        ],
        run: async (input, ctx) =>
          asToolError(async () => {
            await this.assertNotOtherOrgs(input.itemId, ctx.orgId);
            const d = await this.catalog.get(input.itemId);
            return redactOrgs({
              item: d.item,
              versions: d.versions.map((v) => ({
                version: v.version,
                source: v.source,
                sourceRef: v.sourceRef,
                sourceFormat: v.sourceFormat,
                importedAt: v.importedAt,
                ...(v.version === d.item.platformVersion && { manifest: v.manifest }),
              })),
            });
          }),
      }),
      defineOperation({
        id: "plugins.update-preview",
        description:
          "Preview updating a platform plugin to another imported version (super admin): every component's change, the extension step and the org connectors it touches, with the diffHash plugins.update takes. Orgs are given as counts only; the admin console shows which.",
        input: z.object({ itemId: Id, version: Version }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", version: "1.2.0" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/catalog/items/:id/update/preview"],
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id and its versions with plugins.platform-get.",
          },
        ],
        run: async (input, ctx) =>
          asToolError(async () => {
            await this.assertNotOtherOrgs(input.itemId, ctx.orgId);
            return redactOrgs(await this.updater.preview(input.itemId, input.version));
          }),
      }),
      defineOperation({
        id: "plugins.update",
        description:
          "Update a platform plugin to the version previewed (super admin), for every org at once: pass the version and the diffHash plugins.update-preview returned. A preview that is out of date is refused; preview again.",
        input: z.object({ itemId: Id, version: Version, diffHash: Hash }).strict(),
        example: {
          itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c",
          version: "1.2.0",
          diffHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/catalog/items/:id/update"],
        confirm: "platform",
        errors: [
          {
            code: "plugin.upgrade_stale",
            next: "Call plugins.update-preview again and use its new diffHash.",
          },
          {
            code: "plugin.install_in_progress",
            next: "Another update of this plugin is running; try again in a minute.",
          },
        ],
        summary: (i) => ({
          zh: `把平台插件 ${i.itemId} 更新到 ${i.version}`,
          en: `Update platform plugin ${i.itemId} to ${i.version}`,
        }),
        run: async (input, ctx) =>
          asToolError(async () => {
            await this.assertNotOtherOrgs(input.itemId, ctx.orgId);
            return redactOrgs(
              await this.updater.update(
                ctx.actorAccountId,
                input.itemId,
                { version: input.version, diffHash: input.diffHash },
                { auditDetail: viaAgent("plugins.update", ctx) },
              ),
            );
          }),
      }),
    ]);
  }
}
