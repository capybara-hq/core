import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { CatalogIdPathParams, CatalogUpdateBody } from "../../catalog/admin-catalog.schemas.js";
import { CatalogService } from "../../catalog/catalog.service.js";
import type { OrgCatalogItem, PluginUnavailableReason } from "../../catalog/catalog-content.js";
import { CatalogItemPathParams } from "../../catalog/org-catalog.schemas.js";
import { OrgCatalogService } from "../../catalog/org-catalog.service.js";
import { PluginInstaller, uninstallPreviewHash } from "../../catalog/plugin-install.js";
import { PlatformPluginUpdater } from "../../catalog/plugin-upgrade.js";
import { OrgExtensionConfigs, type OrgExtensionView } from "../../extensions/org-config.js";
import { ExtensionAvailability } from "../../extensions/unavailable.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import type { ErrorRole } from "../errors.js";
import { defineOperation } from "../operation.js";
import { redactOrgs } from "../redact-orgs.js";
import { PlatformOperations } from "../registry.js";
import { viaAgent } from "./errors.js";
import { assertNotOtherOrgs, otherOrgItems } from "./other-orgs.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { localized } from "./summary.js";
import { roleFor, unavailableFields, unavailableMessage, unavailableNext } from "./unavailable.js";

/** An org catalog item id (`:itemId` of the org routes). */
const ItemId = CatalogItemPathParams.shape.itemId.max(100);
/** A platform catalog item id (`:id` of the admin routes), named `itemId` like the org's. */
const PlatformItemId = CatalogIdPathParams.shape.id.max(100);
const Version = CatalogUpdateBody.shape.version.max(100);
/** The switch-off confirm: the uninstall preview's hash, or `nothing-installed`. */
const Confirm = z.string().min(1).max(200);

/** Entries per page of the paged lists (the tool caps a bare list at 50). */
const PAGE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { OTHER_ORG } from "./other-orgs.js";

const LOCKED =
  "This plugin is on for every org (or shipped with the platform) and cannot be switched off in one org.";
/** The confirm value of switching off a plugin with nothing installed in the org. */
const NOTHING_INSTALLED = "nothing-installed";

export const NEEDS_INPUT =
  "This plugin needs configuration a person must enter; ask them to enable it on the 插件 page.";

/** The English name of a plugin as next steps and messages name it. */
const enName = (i: OrgCatalogItem): string => localized(i.displayName, i.name).en;

/** The item with the reason its extension stopped loading (state unchanged), when it has one. */
const withStopped = (
  i: OrgCatalogItem,
  stopped: ReadonlyMap<string, PluginUnavailableReason>,
): OrgCatalogItem => {
  const reason = i.reason ?? stopped.get(i.name);
  return reason === undefined ? i : { ...i, reason };
};

/**
 * An org's view of a plugin (`plugins.get`): the state, and when unavailable the reason and the
 * actor's next step (spec §14.2 problem 4: one call decides it).
 */
const brief = (i: OrgCatalogItem, role: ErrorRole) => ({
  id: i.id,
  name: i.name,
  displayName: i.displayName,
  description: i.description,
  scope: i.scope,
  state: i.state,
  ...unavailableFields(i.reason, enName(i), role),
  switchable: i.switchable,
  builtin: i.builtin,
  notDeployed: i.notDeployed,
  latestVersion: i.latestVersion,
  installedVersion: i.installed?.version ?? null,
  componentCounts: i.componentCounts,
  owner: i.owner,
  request: i.request,
});

/** A plugin as `plugins.list` shows it: a compact row; the rest comes from `plugins.get`. */
const row = (i: OrgCatalogItem, role: ErrorRole) => ({
  id: i.id,
  name: i.name,
  state: i.state,
  ...unavailableFields(i.reason, enName(i), role),
  displayName: i.displayName,
  switchable: i.switchable,
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
    @Inject(ExtensionAvailability) private readonly availability: ExtensionAvailability,
  ) {}

  /**
   * Installed (or builtin) plugins whose extension stopped loading: the reason, keyed by plugin
   * name. Their state stays (`on` / `needs_config`) so an org admin can still switch them off;
   * the reason and next step tell why the plugin does nothing now.
   */
  private async stopped(
    items: readonly OrgCatalogItem[],
  ): Promise<Map<string, PluginUnavailableReason>> {
    const names = items
      .filter(
        (i) =>
          i.reason === undefined &&
          i.componentCounts.extension > 0 &&
          (i.installed !== null || i.builtin),
      )
      // a plugin's extension carries the plugin's name
      .map((i) => i.name);
    const out = new Map<string, PluginUnavailableReason>();
    for (const [name, u] of await this.availability.unavailable(names)) out.set(name, u.reason);
    return out;
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "plugins.list",
        description:
          "List the plugins this org can see, one compact row each: the state here (on, off, needs_config, unavailable, not_offered), why an unavailable one cannot be used (reason) and your next step (next; an installed plugin whose extension stopped running keeps its state and carries them too), whether an org admin can switch it, and the org's pending request. Details come from plugins.get. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/catalog"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const [all, role] = await Promise.all([
            this.orgCatalog.list(ctx.orgId, ctx.actorAccountId),
            roleFor(this.kdb.db, ctx),
          ]);
          const stopped = await this.stopped(all);
          return pageOf(
            all.map((i) => row(withStopped(i, stopped), role)),
            startOf(input.cursor),
            PAGE,
          );
        },
      }),
      defineOperation({
        id: "plugins.get",
        description:
          "Read one plugin as this org sees it: its state (with the reason and your next step when it is unavailable, or installed but its extension stopped running), extension, connector templates (presets only, never credentials), dependencies, skills and agent templates.",
        input: z.object({ itemId: ItemId }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/catalog/:itemId"],
        confirm: "read",
        errors: [
          { code: "catalog.item_not_found", next: "Check the plugin id with plugins.list." },
        ],
        run: async (input, ctx) => {
          const [d, role] = await Promise.all([
            this.orgCatalog.detail(ctx.orgId, ctx.actorAccountId, input.itemId),
            roleFor(this.kdb.db, ctx),
          ]);
          return { ...d, item: brief(withStopped(d.item, await this.stopped([d.item])), role) };
        },
      }),
      defineOperation({
        id: "plugins.disable-preview",
        description:
          "Preview switching a plugin off in this org (org admins): what it would remove and which agents use it, and the confirm value plugins.set-enabled needs to switch it off. Show the preview to the person before switching off.",
        input: z.object({ itemId: ItemId }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        // the web previews through the switch route itself (no confirm); writes nothing here
        authz: { orgAction: "org.extensions.manage" },
        mirrors: [],
        confirm: "read",
        errors: [
          { code: "catalog.item_not_found", next: "Check the plugin id with plugins.list." },
        ],
        run: async (input, ctx) => {
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
        },
      }),
      defineOperation({
        id: "plugins.set-enabled",
        description:
          "Switch a plugin on or off in this org. Switching on installs it; a plugin whose enabling needs configuration a person enters (connector credentials, extension config) is refused, so point the person to the 插件 page. Switching off removes what the plugin brought and needs confirm: the value plugins.disable-preview returned with the preview the person saw.",
        input: z.discriminatedUnion("enabled", [
          z.object({ itemId: ItemId, enabled: z.literal(true) }).strict(),
          z.object({ itemId: ItemId, enabled: z.literal(false), confirm: Confirm }).strict(),
        ]),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", enabled: true },
        // the route needs catalog.read; setSwitch requires an org admin (any of skills.manage,
        // connectors.manage, org.extensions.manage, all the admin role)
        authz: { orgAction: "org.extensions.manage" },
        authzNote: "service-enforced",
        mirrors: ["PUT /api/v1/orgs/:orgId/catalog/:itemId/switch"],
        // install inputs a person enters on the web (a plugin that needs them is refused)
        omits: ["inputs"],
        loosens: {
          confirm:
            "also takes `nothing-installed` (plugins.disable-preview's value when nothing is installed), which the route's hash pattern rejects; the service checks confirm only when something is installed",
        },
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
            next: {
              superAdmin:
                "The plugin is stopped on the platform: turn it back on in the admin console under Plugins, then call again.",
              orgAdmin: "The super admin stopped this plugin on the platform; ask them.",
            },
          },
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id with plugins.list.",
          },
          {
            code: "plugin.needs_input",
            next: "Ask the person to enable it on the 插件 page, where they enter its configuration.",
          },
          {
            code: "catalog.approval_required",
            next: "The plugin is not offered to this org: create an access request with requests.create.",
          },
          {
            code: "catalog.not_deployed",
            next: {
              superAdmin:
                "Open the admin console → Extensions → the plugin's extension to see why it is not running (deployment config, permission approval, disabled, or failed to load); fix it, then call again.",
              orgAdmin:
                "Only the super admin can make the plugin's extension run; plugins.get shows the reason. There is no request operation for this (requests.create covers enabling and access only), so tell the super admin directly.",
              member:
                "Ask an org admin: the super admin must set up the plugin's extension on the platform first.",
            },
          },
          {
            code: "plugin.skill_conflict",
            next: "An org skill has the name of one of the plugin's skills; the person resolves it on the web.",
          },
        ],
        // what is known to fail before the card: an unknown plugin, switching off a locked one,
        // switching on one whose extension cannot run (with the role's next step naming it) or
        // that needs a person's input
        precheck: async (i, ctx) => {
          const [item] = UUID_RE.test(i.itemId)
            ? await this.orgCatalog.list(ctx.orgId, ctx.actorAccountId, i.itemId)
            : [];
          if (item === undefined) {
            return { ok: false, code: "catalog.item_not_found", message: "Catalog item not found" };
          }
          if (!i.enabled && !item.switchable) {
            return { ok: false, code: "plugin.scope_locked", message: LOCKED };
          }
          if (i.enabled && item.state === "unavailable" && item.reason !== undefined) {
            const name = enName(item);
            return {
              ok: false,
              code: item.reason === "plugin_disabled" ? "plugin.disabled" : "catalog.not_deployed",
              message: unavailableMessage(item.reason, name),
              next: unavailableNext(item.reason, name),
            };
          }
          if (i.enabled && needsInput(item, await this.extensions.list(ctx.orgId))) {
            return { ok: false, code: "plugin.needs_input", message: NEEDS_INPUT };
          }
          return { ok: true };
        },
        summary: async (i, ctx) => {
          const [item] = await this.orgCatalog.list(ctx.orgId, ctx.actorAccountId, i.itemId);
          if (item === undefined) throw new Error("no such plugin");
          const n = localized(item.displayName, item.name);
          if (i.enabled) {
            return { zh: `在本组织启用插件「${n.zh}」`, en: `Enable plugin "${n.en}" in the org` };
          }
          const live = item.installed;
          if (live === null) {
            return {
              zh: `在本组织停用插件「${n.zh}」（本组织未安装任何内容）`,
              en: `Disable plugin "${n.en}" in the org (nothing is installed here)`,
            };
          }
          // the preview the confirm value binds: what goes, and the agents that lose it
          const p = await this.installer.previewUninstall(ctx.orgId, live.pluginInstallId);
          return {
            zh: `在本组织停用插件「${n.zh}」：移除 ${p.components.length} 个组件，${p.agents.length} 个智能体在用`,
            en: `Disable plugin "${n.en}" in the org: removes ${p.components.length} components; ${p.agents.length} agents use it`,
          };
        },
        run: async (input, ctx) => {
          if (input.enabled) {
            const [item] = await this.orgCatalog.list(ctx.orgId, ctx.actorAccountId, input.itemId);
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
          if (r.kind === "done") {
            return {
              item: brief(r.item, await roleFor(this.kdb.db, ctx)),
            };
          }
          // unreachable: confirm is required when switching off
          return { preview: r.preview, confirm: r.confirm };
        },
      }),
      defineOperation({
        id: "plugins.platform-list",
        description:
          "List the platform's plugins and this org's own (super admin): scope, disabled, versions, pending confirmation and how many orgs use it. Plugins other orgs own are only counted (otherOrgItems); orgs are given as counts. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/catalog/items"],
        // paged by cursor; deleted items and the pending filter are the admin console's
        omits: ["includeDeleted", "limit", "offset", "pending"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const p = await this.catalog.page({ limit: PAGE, offset: startOf(input.cursor) });
          return redactOrgs({
            items: p.items.filter((i) => i.owner.kind !== "org" || i.owner.orgId === ctx.orgId),
            otherOrgItems: await otherOrgItems(this.kdb.db, ctx.orgId),
            next: p.nextOffset === null ? null : String(p.nextOffset),
          });
        },
      }),
      defineOperation({
        id: "plugins.platform-get",
        description:
          "Read one platform catalog plugin (super admin): the item, its platform version and every version with its source. Orgs are given as counts only.",
        input: z.object({ itemId: PlatformItemId }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/catalog/items/:id"],
        renames: { itemId: "id" },
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id with plugins.platform-list.",
          },
        ],
        run: async (input, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, input.itemId, ctx.orgId);
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
        },
      }),
      defineOperation({
        id: "plugins.update-preview",
        description:
          "Preview updating a platform plugin to another imported version (super admin): every component's change, the extension step and the org connectors it touches, with the diffHash plugins.update takes. Orgs are given as counts only; the admin console shows which.",
        input: z.object({ itemId: PlatformItemId, version: Version }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", version: "1.2.0" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/catalog/items/:id/update/preview"],
        renames: { itemId: "id" },
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id and its versions with plugins.platform-get.",
          },
        ],
        run: async (input, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, input.itemId, ctx.orgId);
          return redactOrgs(await this.updater.preview(input.itemId, input.version));
        },
      }),
      defineOperation({
        id: "plugins.update",
        description:
          "Update a platform plugin to the version previewed (super admin), for every org at once: pass the version and the diffHash plugins.update-preview returned. A preview that is out of date is refused; preview again.",
        input: z
          .object({
            itemId: PlatformItemId,
            version: Version,
            diffHash: CatalogUpdateBody.shape.diffHash,
          })
          .strict(),
        example: {
          itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c",
          version: "1.2.0",
          diffHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/catalog/items/:id/update"],
        renames: { itemId: "id" },
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
        summary: async (i, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, i.itemId, ctx.orgId);
          const [{ item }, p] = await Promise.all([
            this.catalog.get(i.itemId),
            this.updater.preview(i.itemId, i.version),
          ]);
          const n = localized(item.displayName, item.name);
          const count = (...changes: string[]) =>
            p.components.filter((c) => changes.includes(c.change)).length;
          const changed = count("upgrade", "downgrade");
          const added = count("added");
          const removed = count("removed");
          // one version for every org: the orgs it is on in, as a count (spec §6.1)
          const orgs = item.enabledOrgs;
          return {
            zh: `把平台插件「${n.zh}」从 ${p.from ?? "无"} 更新到 ${p.to}：组件 ${changed} 个更新、${added} 个新增、${removed} 个移除，影响 ${orgs} 个组织`,
            en: `Update platform plugin "${n.en}" from ${p.from ?? "none"} to ${p.to}: components ${changed} updated, ${added} added, ${removed} removed; ${orgs} orgs affected`,
          };
        },
        run: async (input, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, input.itemId, ctx.orgId);
          return redactOrgs(
            await this.updater.update(
              ctx.actorAccountId,
              input.itemId,
              { version: input.version, diffHash: input.diffHash },
              { auditDetail: viaAgent("plugins.update", ctx) },
            ),
          );
        },
      }),
    ]);
  }
}
