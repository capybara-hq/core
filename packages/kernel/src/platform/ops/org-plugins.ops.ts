import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AppearanceService } from "../../catalog/appearance.service.js";
import { CatalogScopeService } from "../../catalog/catalog-scope.service.js";
import {
  CatalogConnectorInput,
  CatalogItemPathParams,
  OrgPluginInstallBody,
  PluginInstallPathParams,
} from "../../catalog/org-catalog.schemas.js";
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
import { ApiError } from "../../errors.js";
import { OrgExtensionConfigs } from "../../extensions/org-config.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { ThemesService } from "../../themes/themes.service.js";
import type { ConnectorAuth } from "../../tools/credentials.js";
import {
  clientProblem,
  headersWebOnly,
  type TemplateParams,
  type TemplateTarget,
  templateConnectorInput,
  templatePersonFields,
} from "../connector-person-fields.js";
import { FileRefSchema } from "../file-ref.js";
import {
  defineOperation,
  type HandoffView,
  type OperationContext,
  type PrecheckResult,
} from "../operation.js";
import {
  type PersonFieldSpec,
  PersonFieldsRefused,
  type PersonFieldTarget,
  personFieldParams,
  planPersonFields,
  secretFieldsOf,
} from "../person-fields.js";
import { PlatformOperations } from "../registry.js";
import { appearanceSummary, reviewBrief } from "./catalog-admin.ops.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { afterTaken, enteredUnder, nestedConfig, takePersonInputs } from "./person-inputs.js";
import { localized, named, orElse } from "./summary.js";

const InstallId = PluginInstallPathParams.shape.installId.max(100);
/** An org-owned plugin's catalog item id (`:id` of the owned-plugins routes). */
const OwnedId = OrgOwnedPluginParams.shape.id;
const EXAMPLE_ID = "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c";

const ItemId = CatalogItemPathParams.shape.itemId.max(100);

/**
 * The model's input for one connector template (the install's and configure's `connectors` entry
 * without its secrets): name, slug, the endpoint fields the template lets the org edit, and an
 * OAuth client's id. The credential and the client secret are person fields.
 */
const TemplateInput = CatalogConnectorInput.pick({ name: true, slug: true, endpoint: true })
  .extend({
    client: z
      .object({ clientId: z.string().min(1).max(500) })
      .strict()
      .optional(),
  })
  .strict();
const Templates = z
  .record(z.string().min(1).max(100), TemplateInput)
  .refine((v) => Object.keys(v).length <= 50, { message: "Too many connector templates" });

const InstallInput = z
  .object({
    itemId: ItemId,
    templates: Templates.optional().describe(
      "Per connector template id (plugins.get lists them), the connector's name, slug, endpoint fields and OAuth client id; never a credential.",
    ),
    extensionConfig: OrgPluginInstallBody.shape.extensionConfig.describe(
      "The plugin's extension org config without its secret fields (extensions.org-config shows the schema).",
    ),
    askPerson: personFieldParams.askPerson,
  })
  .strict();

const ConfigureInput = z
  .object({
    itemId: ItemId,
    templates: Templates.describe(
      "Per missing connector template id (plugins.get shows the plugin needs_config), the connector's name, slug, endpoint fields and OAuth client id; never a credential. Name every template to create, even with {}.",
    ),
    askPerson: personFieldParams.askPerson,
  })
  .strict();

/** The card's person-field paths, from the plan (`personAsk`). */
const entersText = (ctx: Pick<OperationContext, "personAsk">) => {
  const ask = ctx.personAsk ?? [];
  return ask.length === 0
    ? { zh: "", en: "" }
    : { zh: `；由本人填写 ${ask.join("、")}`, en: `; the person enters ${ask.join(", ")}` };
};

/** A template as the person-field helpers take it. */
const targetOf = (t: {
  id: string;
  displayName: { en: string; zh?: string } | null | undefined;
  auth: unknown;
}): TemplateTarget => ({
  id: t.id,
  name: {
    zh: named(t.displayName?.zh ?? t.displayName?.en ?? t.id),
    en: named(t.displayName?.en ?? t.id),
  },
  auth: t.auth as ConnectorAuth,
});

/**
 * The refusal of a template input the card cannot complete, or ok: a credential the card cannot
 * ask for (custom headers), an OAuth client without its id, or a client for a template that takes
 * none.
 */
function templatesRefusal(
  templates: readonly TemplateTarget[],
  params: Readonly<Record<string, TemplateParams>> | undefined,
): PrecheckResult {
  for (const t of templates) {
    const where = `Connector template ${t.name.en} (${t.id})`;
    const why = headersWebOnly(t.auth, where);
    if (why !== null) return { ok: false, code: "platform.secret_record_web_only", message: why };
    const client = clientProblem(t.auth, params?.[t.id]?.client, where);
    if (client !== null) return { ok: false, code: "validation_failed", message: client };
  }
  return { ok: true };
}

/** The `connectors` body of the install and configure routes: params plus entered values. */
function connectorInputs(
  templates: readonly TemplateTarget[],
  params: Readonly<Record<string, TemplateParams>> | undefined,
  entered: Readonly<Record<string, string>>,
): Record<string, Record<string, unknown>> | undefined {
  const out: Record<string, Record<string, unknown>> = {};
  for (const t of templates) {
    const given = params?.[t.id];
    const hasEntered = Object.keys(entered).some((p) => p.startsWith(`connectors.${t.id}.`));
    if (given === undefined && !hasEntered) continue;
    out[t.id] = templateConnectorInput(t, given, entered);
  }
  // a template the plan does not know (not on here) goes to the service as given: it refuses it
  for (const [id, given] of Object.entries(params ?? {})) {
    if (!(id in out) && !templates.some((t) => t.id === id)) out[id] = { ...given };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

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
 * The link card to the org's Plugins page with a staged upload (`plugins.upload`,
 * `plugins.upload-review`); without the plugin's name the title names none.
 */
export const uploadHandoff = (result: unknown): HandoffView | null => {
  const r = result as { stagingId?: unknown; review?: { name?: unknown } } | null;
  if (typeof r?.stagingId !== "string") return null;
  const name = typeof r.review?.name === "string" ? named(r.review.name) : null;
  return {
    kind: "handoff",
    title:
      name === null
        ? { zh: "确认插件的上传", en: "Confirm the plugin upload" }
        : { zh: `确认插件 ${name} 的上传`, en: `Confirm the upload of plugin ${name}` },
    target: { type: "link", url: `/plugins?staging=${encodeURIComponent(r.stagingId)}` },
  };
};

/**
 * The org's own plugin operations of the `Platform` tool (spec §14.2): the org's plugin installs
 * (list, uninstall; installing with inputs and creating missing connectors, their secrets entered
 * by the person on the card, platform web parity spec §7.2), its staged uploads (staging a package
 * of the conversation, reading one; confirming is done by a person on the web), and the plugins it
 * owns (share, delete after a preview, withdraw a
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
    @Inject(OrgExtensionConfigs) private readonly extensions: OrgExtensionConfigs,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
  ) {}

  /**
   * What installing a plugin asks the person for (platform web parity spec §7.2): the connector
   * templates whose connector the install creates (on in the org, none kept from an earlier
   * switch-off, as the install wizard asks), and the secret fields of its extension's org config
   * under `extensionConfig.` (stored ones count as set; one the schema walk cannot address is web
   * only). An extension whose org view cannot be read refuses the call: its secrets are unknown.
   */
  private async installTargets(ctx: OperationContext, itemId: string) {
    const d = await this.orgCatalog.detail(ctx.orgId, ctx.actorAccountId, itemId);
    const templates = d.templates.filter((t) => t.on && !t.connected).map(targetOf);
    let fields: PersonFieldSpec[] = [];
    let recordOnly: string[] = [];
    if (d.extension !== null) {
      const views = await this.extensions.list(ctx.orgId);
      // the view of this catalog item; by plugin name only when that name is unambiguous
      const byName = views.filter((e) => e.plugin === d.extension);
      const v =
        views.find((e) => e.catalogItem?.itemId === itemId) ??
        (byName.length === 1 ? byName[0] : undefined);
      if (v === undefined && byName.length > 1) {
        throw new PersonFieldsRefused(
          `Several extensions named ${d.extension} are in this org, so the secret fields of this plugin's extension are not known; install the plugin on the web (Plugins page).`,
        );
      }
      if (v === undefined) {
        throw new PersonFieldsRefused(
          `Cannot read the config schema of the plugin's extension ${d.extension} now, so its secret fields are unknown; try again, or install the plugin on the web (Plugins page).`,
        );
      } else {
        const stored = new Set(v.secrets.filter((x) => x.set).map((x) => x.path));
        const found = secretFieldsOf(v.orgConfigSchema, stored);
        const asked = new Set(found.fields.map((f) => f.path));
        fields = found.fields.map((f) => ({ ...f, path: `extensionConfig.${f.path}` }));
        recordOnly = [
          ...new Set([
            ...found.recordOnly,
            ...v.secrets.map((x) => x.path).filter((p) => !asked.has(p)),
          ]),
        ].map((p) => `extensionConfig.${p}`);
      }
    }
    return {
      item: d.item,
      templates,
      target: {
        target: {
          zh: `插件「${localized(d.item.displayName, d.item.name).zh}」的安装`,
          en: `${localized(d.item.displayName, d.item.name).en}: install`,
        },
        fields: [...templatePersonFields(templates), ...fields],
        recordOnly,
      } satisfies PersonFieldTarget,
    };
  }

  /** The missing connectors of an installed plugin that a configure call names. */
  private async configureTargets(ctx: OperationContext, itemId: string, named: string[]) {
    const missing = await this.installer.missingConnectors(ctx.orgId, itemId);
    if (missing === undefined) {
      throw new ApiError("plugin.install_not_found", "The plugin is not installed in this org");
    }
    return missing.templates
      .filter((t) => named.includes(t.id))
      .map((t) =>
        targetOf({ id: t.id, displayName: t.file.displayName, auth: t.file.template.auth }),
      );
  }

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
          "List the plugin installs of this org (org admins), one compact row each: the plugin, the install state (installing, installed, failed, uninstalling), a failure's step and code (reason), the version and how many components it brought. Pages by 50: pass the returned next as params.cursor.",
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
        id: "plugins.upload",
        description:
          "Stage a plugin package as this org's own upload (org admins): a .tgz plugin package of this conversation, e.g. one you packed in the sandbox and delivered with Deliver, passed as file: { fileId }; at most the deployment's package limit. Checks the whole plugin and stages it for 24 hours; returns what it brings and, for a new version of the org's own plugin, the update it applies. Nothing is added until the person confirms the upload on the web (Plugins page); a plugin with an extension then waits for the super admin.",
        input: z.object({ file: FileRefSchema }).strict(),
        example: { file: { fileId: EXAMPLE_ID } },
        authz: { orgAction: "catalog.upload" },
        mirrors: ["POST /api/v1/orgs/:orgId/catalog/uploads/file"],
        // the route's raw body
        extras: ["file"],
        confirm: "org",
        errors: [
          {
            code: "catalog.invalid_manifest",
            next: "The package is not a valid plugin (the details list each problem); fix it, pack and deliver it again.",
          },
          {
            code: "catalog.custom_disabled",
            next: "This deployment does not allow the org's own skills, agent templates or connector templates that the plugin brings; tell the person.",
          },
          {
            code: "plugin.name_taken",
            next: "Another owner has a live plugin of this name; rename the plugin in its manifest, pack it and retry.",
          },
          {
            code: "plugin.dependency_unavailable",
            next: "The plugin depends on plugins this org cannot use (the details list them); install those first, or remove the dependency.",
          },
          {
            code: "catalog.version_exists",
            next: "This version was uploaded already; raise the version in the manifest, pack it and retry.",
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
            zh: `暂存插件包「${f}」作为本组织的上传（确认在网页上进行）`,
            en: `Stage the plugin package "${f}" as this org's upload (confirmed on the web)`,
          };
        },
        run: async (_input, ctx) => {
          const f = ctx.file;
          if (f === undefined) throw new Error("plugins.upload: the file is missing");
          const r = await this.uploads.prepare(ctx.actorAccountId, ctx.orgId, f.bytes, {
            auditDetail: viaAgent("plugins.upload", ctx),
          });
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
            next: "Nothing is added yet: the person confirms the upload on the web (Plugins page).",
          };
        },
        handoff: (_i, result) => uploadHandoff(result),
      }),
      defineOperation({
        id: "plugins.upload-review",
        description:
          "Read one of this org's staged plugin uploads (org admins): what the plugin brings, and for a new version of the org's own plugin the update it applies. plugins.upload stages one; confirming it is done by a person on the web (Plugins page).",
        input: z.object({ stagingId: OrgUploadStagingParams.shape.stagingId }).strict(),
        example: { stagingId: EXAMPLE_ID },
        authz: { orgAction: "catalog.upload" },
        mirrors: ["GET /api/v1/orgs/:orgId/catalog/uploads/:stagingId"],
        confirm: "read",
        errors: [
          {
            code: "plugin.staging_not_found",
            next: "The staged upload expired (24 hours), was confirmed, or is not this org's; the person uploads it again on the Plugins page.",
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
            next: "The person confirms the upload on the web (Plugins page).",
          };
        },
        handoff: (_i, result) => uploadHandoff(result),
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
          "Apply a plugin's suggested appearance in this org (org admins; the Extensions page's \"Apply this plugin's appearance\" action), for a plugin whose extension is on here: in one step, its theme becomes the org's default theme (whether members may pick their own stays as it is) and each component it suggests replaces the built-in block of its slot (shell.brand, conversation.empty, conversation.composer.frame) in the org's arrangement. The card shows exactly what changes; a theme that is not on in the org refuses the whole call, a component that is not available is skipped.",
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
      defineOperation<z.infer<typeof InstallInput>>({
        id: "plugins.install",
        description:
          "Install a plugin in this org with its inputs (org admins; the web's install wizard): per connector template the connector's name, slug, endpoint fields and OAuth client id (templates), and the extension's org config without secrets (extensionConfig). Secrets are never params: the person enters them on the confirmation card, at connectors.<templateId>.credential.token (or .credential.username / .credential.password, .client.clientSecret) and extensionConfig.<field>. Required ones are asked even when not listed in askPerson. A plugin that needs no input is switched on with plugins.set-enabled instead.",
        input: InstallInput,
        example: {
          itemId: EXAMPLE_ID,
          templates: { github: { endpoint: { url: "https://api.githubcopilot.com/mcp/" } } },
          askPerson: ["connectors.github.credential.token"],
        },
        // the route needs catalog.read; the service re-checks the plugin's component actions
        authz: { orgAction: "org.extensions.manage" },
        authzNote: "service-enforced",
        mirrors: ["POST /api/v1/orgs/:orgId/catalog/:itemId/install"],
        // the route's connectors carry credentials: templates holds the rest, secrets are person fields
        omits: ["connectors"],
        extras: ["templates", "askPerson"],
        confirm: "org",
        errors: [
          { code: "catalog.item_not_found", next: "Check the plugin id with plugins.list." },
          {
            code: "plugin.already_installed",
            next: "The plugin is installed in this org already; plugins.get shows its state.",
          },
          {
            code: "plugin.install_failed",
            next: "The install failed at the step its details name and was rolled back; fix that (often the connector's endpoint or credential) and call again: the person enters the credentials again on a new card.",
          },
          {
            code: "catalog.not_deployed",
            next: "The plugin's extension does not run on the platform; plugins.get shows why. Tell the person; the super admin fixes it.",
          },
          {
            code: "validation_failed",
            next: "The error's details name the fields (connectors.<templateId>.… or extensionConfig.…); correct the params and call again.",
          },
          {
            code: "platform.secret_record_web_only",
            next: "Tell the person to finish this on the Plugins page on the web.",
          },
        ],
        precheck: async (i, ctx) => {
          let r: Awaited<ReturnType<OrgPluginsOperations["installTargets"]>> | undefined;
          const read = await precheckBy(async () => {
            r = await this.installTargets(ctx, i.itemId);
          });
          if (!read.ok || r === undefined) return read;
          if (r.item.installed !== null) {
            return {
              ok: false,
              code: "plugin.already_installed",
              message: `Plugin ${r.item.name} is installed in this org already`,
            };
          }
          return templatesRefusal(r.templates, i.templates);
        },
        personFields: async (i, ctx) => {
          const { target } = await this.installTargets(ctx, i.itemId);
          // the extension config is a dynamic record: its secrets are checked like values
          const plan = planPersonFields(target, {
            values: { extensionConfig: i.extensionConfig ?? {} },
            askPerson: [],
            clearSecrets: [],
          });
          if (!plan.ok) throw new PersonFieldsRefused(plan.message);
          return target;
        },
        summary: async (i, ctx) => {
          const { item, templates } = await this.installTargets(ctx, i.itemId);
          const n = localized(item.displayName, item.name);
          const e = entersText(ctx);
          return {
            zh: `在本组织安装插件「${n.zh}」${item.latestVersion}（${templates.length} 个连接器）${e.zh}`,
            en: `Install plugin "${n.en}" ${item.latestVersion} in the org (${templates.length} connectors)${e.en}`,
          };
        },
        run: async (input, ctx) => {
          const { templates } = await this.installTargets(ctx, input.itemId);
          // the install runs steps in transactions of their own under the org row lock, so the
          // values are taken first (takePersonInputs)
          const { entered, auditDetail } = await takePersonInputs("plugins.install", ctx);
          const connectors = connectorInputs(templates, input.templates, entered);
          const ext = enteredUnder(entered, "extensionConfig.");
          const extensionConfig =
            input.extensionConfig !== undefined || Object.keys(ext).length > 0
              ? nestedConfig(input.extensionConfig ?? {}, ext, [])
              : undefined;
          const r = await this.orgCatalog
            .install(
              ctx.orgId,
              ctx.actorAccountId,
              input.itemId,
              {
                ...(connectors !== undefined && { connectors }),
                ...(extensionConfig !== undefined && { extensionConfig }),
              } as Parameters<OrgCatalogService["install"]>[3],
              undefined,
              auditDetail,
            )
            .catch((e: unknown) => {
              throw afterTaken(e, entered);
            });
          return { installed: r.installed, install: installRow(r.install) };
        },
      }),
      defineOperation<z.infer<typeof ConfigureInput>>({
        id: "plugins.configure-connectors",
        description:
          "Create the connectors an installed plugin is missing (org admins; the plugin shows needs_config, e.g. after a platform update added a connector template): per missing template its name, slug, endpoint fields and OAuth client id (templates). Credentials are never params: the person enters them on the confirmation card at connectors.<templateId>.credential.token (or .credential.username / .credential.password, .client.clientSecret). Required ones are asked even when not listed in askPerson.",
        input: ConfigureInput,
        example: {
          itemId: EXAMPLE_ID,
          templates: { github: {} },
          askPerson: ["connectors.github.credential.token"],
        },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/catalog/:itemId/connectors"],
        // the route's inputs.connectors carry credentials: templates holds the rest
        omits: ["inputs"],
        extras: ["templates", "askPerson"],
        confirm: "org",
        errors: [
          {
            code: "plugin.install_not_found",
            next: "The plugin is not installed in this org; install it with plugins.install.",
          },
          {
            code: "validation_failed",
            next: "The error's details name the fields (connectors.<templateId>.… or extensionConfig.…); correct the params and call again.",
          },
          {
            code: "platform.secret_record_web_only",
            next: "Tell the person to finish this on the Plugins page on the web.",
          },
        ],
        precheck: async (i, ctx) => {
          let templates: TemplateTarget[] = [];
          const read = await precheckBy(async () => {
            templates = await this.configureTargets(ctx, i.itemId, Object.keys(i.templates));
          });
          return read.ok ? templatesRefusal(templates, i.templates) : read;
        },
        personFields: async (i, ctx) => {
          const templates = await this.configureTargets(ctx, i.itemId, Object.keys(i.templates));
          return {
            target: { zh: "插件缺少的连接器", en: "Plugin: missing connectors" },
            fields: templatePersonFields(templates),
          };
        },
        summary: async (i, ctx) => {
          const n = await orElse(
            async () => {
              const d = await this.orgCatalog.detail(ctx.orgId, ctx.actorAccountId, i.itemId);
              return localized(d.item.displayName, d.item.name);
            },
            { zh: named(i.itemId), en: named(i.itemId) },
          );
          const ids = Object.keys(i.templates).map(named).join(", ");
          const e = entersText(ctx);
          return {
            zh: `为插件「${n.zh}」创建缺少的连接器 ${ids}${e.zh}`,
            en: `Create the missing connectors ${ids} of plugin "${n.en}"${e.en}`,
          };
        },
        run: async (input, ctx) => {
          const templates = await this.configureTargets(
            ctx,
            input.itemId,
            Object.keys(input.templates),
          );
          // each connector is created and recorded in transactions of its own (as the route)
          const { entered, auditDetail } = await takePersonInputs(
            "plugins.configure-connectors",
            ctx,
          );
          return {
            connectors: await this.installer
              .configureConnectors(
                ctx.orgId,
                ctx.actorAccountId,
                input.itemId,
                {
                  connectors: connectorInputs(templates, input.templates, entered) ?? {},
                } as Parameters<PluginInstaller["configureConnectors"]>[3],
                { auditDetail },
              )
              .catch((e: unknown) => {
                throw afterTaken(e, entered);
              }),
          };
        },
      }),
    ]);
  }
}
