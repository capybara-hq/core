import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  CatalogDisabledBody,
  CatalogGitImportBody,
  CatalogIdPathParams,
  CatalogNpmImportBody,
  CatalogScope,
  CatalogScopeBody,
  CatalogScopeOrgs,
  CatalogShownBody,
  CatalogStagingPathParams,
} from "../../catalog/admin-catalog.schemas.js";
import { CatalogService } from "../../catalog/catalog.service.js";
import { CatalogScopeService, type ScopePreview } from "../../catalog/catalog-scope.service.js";
import { PluginImport, type PluginReview } from "../../catalog/plugin-import.js";
import { ApiError } from "../../errors.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { assertNotOtherOrgs, OTHER_ORG } from "./other-orgs.js";
import { localized, orElse } from "./summary.js";

/** A platform catalog item id (`:id` of the admin routes), named `itemId` like the org's. */
const ItemId = CatalogIdPathParams.shape.id.max(100);
const StagingId = CatalogStagingPathParams.shape.stagingId.max(100);

/** `plugins.set-shown` on a plugin an org owns. */
export const ORG_OWNED =
  "An org owns this plugin and manages who sees it; the super admin changes that in the admin console, not here.";

/** Where the person confirms a staged import (the admin console's import review). */
export const reviewUrl = (stagingId: string) => `/admin/plugins/import?staging=${stagingId}`;

/** What only a person does with a staged import, after reading its review on the web. */
export const CONFIRM_ON_WEB =
  "Nothing is imported yet. Give the person the reviewUrl: they read the review (the extension's permissions among it) and confirm the import on the web. Confirming approves extension permissions, which only a person does.";

/** A staged import's review as the model needs it: what it brings, not the files themselves. */
export const reviewBrief = (r: PluginReview) => ({
  name: r.name,
  version: r.version,
  displayName: r.displayName ?? null,
  publisher: r.publisher,
  description: r.description,
  format: r.format,
  source: { kind: r.source.kind, ref: r.source.ref },
  extension:
    r.extension === undefined
      ? null
      : {
          name: r.extension.name,
          version: r.extension.version,
          action: r.extension.action,
          deployed: r.extension.deployed,
          currentVersion: r.extension.currentVersion,
          sensitive: r.extension.sensitive,
          addedPermissions: r.extension.added,
          warnings: r.extension.warnings.length,
        },
  skills: r.skills.map((s) => s.name),
  connectorTemplates: r.connectorTemplates.map((t) => t.id),
  agentTemplates: (r.agentTemplates ?? []).map((t) => t.name),
  dependencies: r.dependencies,
});

/**
 * Skills the change would offer twice, one line per org (the org named: platform data, spec §14.5
 * item 1); the plugins already using a name are counted, never named (they may be another org's
 * own plugins).
 */
const conflictText = (cs: ScopePreview["conflicts"]): string =>
  cs
    .map(
      (c) =>
        `skill "${c.name}" is already used in org ${c.orgName} (${c.plugins.length > 0 ? `${c.plugins.length} plugin(s)` : "its own skill"})`,
    )
    .join("; ");

/** A scope preview as the admin console shows it (orgs named); conflicting plugins counted. */
const previewBrief = (p: ScopePreview) => ({
  affected: p.affected,
  agentsAffected: p.affected.reduce((n, a) => n + a.agents.length, 0),
  needsConfig: p.needsConfig,
  replaced: p.replaced,
  conflicts: p.conflicts.map((c) => ({
    orgId: c.orgId,
    orgName: c.orgName,
    name: c.name,
    skills: c.skills,
    plugins: c.plugins.length,
  })),
  scopeHash: p.scopeHash,
});

/**
 * The super admin's platform catalog operations of the `Platform` tool (spec §14.2, §14.5 item
 * 1): prepare an import from npm or git and read its review (a person confirms it on the web: the
 * confirm approves extension permissions), preview and change a plugin's scope, disable or enable
 * it on the platform, show or hide it, and delete it. Platform plugins and the org's own come with
 * the admin console's data in full (orgs named); another org's own plugin is refused (the phase-1
 * rule), and the plugins in a name conflict are counted, never named.
 */
@Injectable()
export class CatalogAdminOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /** The precheck refusal of another org's private plugin (the phase-1 rule), else null. */
  private async otherOrgs(itemId: string, orgId: string): Promise<PrecheckResult | null> {
    try {
      await assertNotOtherOrgs(this.kdb.db, itemId, orgId);
      return null;
    } catch {
      return { ok: false, code: "catalog.item_not_found", message: OTHER_ORG };
    }
  }

  /** Whether an org owns the item (its owner org manages it, not the super admin's agent). */
  private async orgOwned(itemId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) return false;
    const row = await this.kdb.db
      .selectFrom("catalog_items")
      .select("owner_org_id")
      .where("id", "=", itemId)
      .executeTakeFirst();
    return row?.owner_org_id != null;
  }

  /**
   * A name conflict the service found at write time (the precheck skipped, or a change landed in
   * between) without the plugins it names, which may be another org's own: the same error code,
   * the orgs and skill names from the current preview, the plugins counted, no details.
   */
  private async withoutPluginNames<T>(
    itemId: string,
    target: { scope: "all" | "optional" | "named"; orgs?: string[] } | { disabled: true } | null,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (e) {
      if (
        !(e instanceof ApiError) ||
        (e.code !== "plugin.skill_conflict" && e.code !== "agent_template.name_taken")
      ) {
        throw e;
      }
      const conflicts = await orElse(
        async () => (target === null ? [] : (await this.scope.preview(itemId, target)).conflicts),
        [] as ScopePreview["conflicts"],
      );
      throw new ApiError(
        e.code,
        conflicts.length > 0
          ? `The change would offer a name twice: ${conflictText(conflicts)}`
          : "The change would offer a skill or agent template name twice in an org that already uses it",
      );
    }
  }

  /** The precheck refusal of an unknown or deleted item (`catalog.get` includes deleted ones). */
  private async live(itemId: string): Promise<PrecheckResult> {
    let deleted = false;
    const r = await precheckBy(async () => {
      deleted = (await this.catalog.get(itemId)).item.deletedAt !== null;
    });
    if (!r.ok) return r;
    return deleted
      ? { ok: false, code: "catalog.item_not_found", message: "Catalog item not found" }
      : { ok: true };
  }

  /** The item's names for a card, or the id when it cannot be read. */
  private names(itemId: string): Promise<{ zh: string; en: string }> {
    return orElse(
      async () => {
        const { item } = await this.catalog.get(itemId);
        return localized(item.displayName, item.name);
      },
      { zh: itemId, en: itemId },
    );
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "plugins.import-npm",
        description:
          "Prepare importing a plugin from the platform's npm registry into the catalog (super admin): fetches and checks the package (version: a version, dist-tag or range; default latest) and stages it for 24 hours. Returns what it brings and a reviewUrl; nothing is imported until the person confirms it there.",
        input: CatalogNpmImportBody.strict(),
        example: { package: "@acme/capybara-plugin-crm" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/catalog/import/npm"],
        confirm: "platform",
        errors: [
          {
            code: "catalog.version_exists",
            next: "This version is in the catalog already: update the plugin to it with plugins.update-preview.",
          },
          {
            code: "catalog.name_conflict",
            next: "A catalog plugin of this name comes from another npm package; check the package name.",
          },
          {
            code: "catalog.invalid_manifest",
            next: "The package is not a valid plugin (the details list each problem); tell the person.",
          },
          {
            code: "packages.npm_failed",
            next: "The registry could not be reached or has no such version; check the name and version, or try again later.",
          },
        ],
        summary: (i) => ({
          zh: `从 npm 准备导入插件 ${i.package}${i.version !== undefined ? `@${i.version}` : ""}（确认在网页上进行）`,
          en: `Prepare importing plugin ${i.package}${i.version !== undefined ? `@${i.version}` : ""} from npm (confirmed on the web)`,
        }),
        run: async (input, ctx) => {
          const r = await this.pluginImport.prepareNpm(
            ctx.actorAccountId,
            {
              package: input.package,
              ...(input.version !== undefined && { version: input.version }),
            },
            { auditDetail: viaAgent("plugins.import-npm", ctx) },
          );
          return {
            stagingId: r.stagingId,
            review: reviewBrief(r.review),
            reviewUrl: reviewUrl(r.stagingId),
            next: CONFIRM_ON_WEB,
          };
        },
      }),
      defineOperation({
        id: "plugins.import-git",
        description:
          "Prepare importing a plugin straight from git into the catalog (super admin; a one-off, no marketplace): url is an https git URL or owner/repo, ref a branch, tag or commit (default the remote HEAD), path the plugin's directory (default the root). Stages it for 24 hours and returns what it brings and a reviewUrl; nothing is imported until the person confirms it there.",
        input: CatalogGitImportBody,
        example: { url: "acme/capybara-plugin-crm", ref: "v1.2.0" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/catalog/import/git"],
        confirm: "platform",
        errors: [
          {
            code: "marketplace.git_failed",
            next: "The repository could not be read: check the URL and ref, or try again later.",
          },
          {
            code: "marketplace.private_address",
            next: "The URL points at a private address, which the platform refuses; use a public https URL.",
          },
          {
            code: "catalog.version_exists",
            next: "This version is in the catalog already: update the plugin to it with plugins.update-preview.",
          },
          {
            code: "catalog.invalid_manifest",
            next: "The directory is not a valid plugin (the details list each problem); check path, or tell the person.",
          },
        ],
        summary: (i) => ({
          zh: `从 git 准备导入插件 ${i.url}${i.ref !== undefined ? `#${i.ref}` : ""}${i.path !== undefined ? ` ${i.path}` : ""}（确认在网页上进行）`,
          en: `Prepare importing plugin ${i.url}${i.ref !== undefined ? `#${i.ref}` : ""}${i.path !== undefined ? ` ${i.path}` : ""} from git (confirmed on the web)`,
        }),
        run: async (input, ctx) => {
          const r = await this.catalog.importFromGit(
            ctx.actorAccountId,
            {
              url: input.url,
              ...(input.ref !== undefined && { ref: input.ref }),
              ...(input.path !== undefined && { path: input.path }),
            },
            { auditDetail: viaAgent("plugins.import-git", ctx) },
          );
          return {
            stagingId: r.stagingId,
            review: reviewBrief(r.review),
            reviewUrl: reviewUrl(r.stagingId),
            next: CONFIRM_ON_WEB,
          };
        },
      }),
      defineOperation({
        id: "plugins.import-review",
        description:
          "Read a staged platform import (super admin): what the plugin brings (extension and its added permissions, skills, connector and agent templates, dependencies) and the reviewUrl where the person confirms it.",
        input: z.object({ stagingId: StagingId }).strict(),
        example: { stagingId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/catalog/imports/:stagingId"],
        confirm: "read",
        errors: [
          {
            code: "plugin.staging_not_found",
            next: "The staged import expired (24 hours) or was confirmed already: prepare it again with plugins.import-npm or plugins.import-git.",
          },
        ],
        run: async (input) => {
          const r = await this.pluginImport.staged(input.stagingId);
          return {
            stagingId: r.stagingId,
            review: reviewBrief(r.review),
            ...(r.permissionsMismatch !== undefined && {
              permissionsMismatch: r.permissionsMismatch,
            }),
            reviewUrl: reviewUrl(r.stagingId),
            next: CONFIRM_ON_WEB,
          };
        },
      }),
      defineOperation({
        id: "plugins.scope-preview",
        description:
          "Preview changing where a platform plugin is on (super admin): a scope (all: every org; optional: orgs switch it on; named: only the orgs listed, with orgs) or disabled: true (off everywhere). Returns the orgs that lose it (with the agents there), the components it takes back, name conflicts, and the scopeHash plugins.set-scope or plugins.set-disabled needs. Nothing is written; show the preview to the person first.",
        input: z
          .object({
            itemId: ItemId,
            scope: CatalogScope.optional(),
            orgs: CatalogScopeOrgs.optional(),
            disabled: z.literal(true).optional(),
          })
          .strict()
          .refine((b) => (b.disabled === true) !== (b.scope !== undefined), {
            message: "send either scope (with orgs for named) or disabled: true",
          })
          .refine((b) => b.disabled === undefined || b.orgs === undefined, {
            message: "orgs: only allowed with scope named",
            path: ["orgs"],
          }),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", scope: "optional" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/catalog/items/:id/scope/preview"],
        renames: { itemId: "id" },
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id with plugins.platform-list.",
          },
          {
            code: "plugin.builtin",
            next: "A built-in plugin is on in every org; its scope cannot change and it cannot be disabled.",
          },
          {
            code: "validation_failed",
            next: "Pass existing org ids in orgs (only with scope named); the orgs operations list them.",
          },
        ],
        run: async (input, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, input.itemId, ctx.orgId);
          const p = await this.scope.preview(
            input.itemId,
            input.scope === undefined
              ? { disabled: true }
              : { scope: input.scope, ...(input.orgs !== undefined && { orgs: input.orgs }) },
          );
          return previewBrief(p);
        },
      }),
      defineOperation({
        id: "plugins.set-scope",
        description:
          "Change where a platform plugin is on (super admin), for every org at once: pass the scope (and orgs for named) and the scopeHash plugins.scope-preview returned for that same target. Orgs that lose it have it removed by the scope sync; a preview that is out of date is refused.",
        input: z.object({ itemId: ItemId, ...CatalogScopeBody.shape }).strict(),
        example: {
          itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c",
          scope: "optional",
          scopeHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/catalog/items/:id/scope"],
        renames: { itemId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id with plugins.platform-list.",
          },
          {
            code: "plugin.builtin",
            next: "A built-in plugin is on in every org; its scope cannot change and it cannot be disabled.",
          },
          {
            code: "plugin.scope_stale",
            next: "Call plugins.scope-preview again with the same target, show the new preview, and call again with its scopeHash.",
          },
          {
            code: "catalog.item_pending",
            next: "The plugin's first version waits for the super admin's confirmation in the admin console (Plugins → 待确认); confirm or reject it there first.",
          },
          {
            code: "plugin.skill_conflict",
            next: "Those orgs already have a skill of that name: narrow the target (scope named without them) or have the name resolved in those orgs, then preview again.",
          },
        ],
        precheck: async (i, ctx) => {
          const other = await this.otherOrgs(i.itemId, ctx.orgId);
          if (other !== null) return other;
          let hash = "";
          let conflicts: ScopePreview["conflicts"] = [];
          const r = await precheckBy(async () => {
            const p = await this.scope.preview(i.itemId, {
              scope: i.scope,
              ...(i.orgs !== undefined && { orgs: i.orgs }),
            });
            hash = p.scopeHash;
            conflicts = p.conflicts;
          });
          if (!r.ok) return r;
          if (conflicts.length > 0) {
            return {
              ok: false,
              code: "plugin.skill_conflict",
              message: `The change would offer a skill twice: ${conflictText(conflicts)}`,
            };
          }
          return hash === i.scopeHash
            ? { ok: true }
            : {
                ok: false,
                code: "plugin.scope_stale",
                message: "What this change affects has changed since the preview",
              };
        },
        summary: async (i) => {
          const [n, p] = await Promise.all([
            this.names(i.itemId),
            this.scope.preview(i.itemId, {
              scope: i.scope,
              ...(i.orgs !== undefined && { orgs: i.orgs }),
            }),
          ]);
          const named = i.scope === "named" ? `（${i.orgs?.length ?? 0} 个组织）` : "";
          const namedEn = i.scope === "named" ? ` (${i.orgs?.length ?? 0} orgs)` : "";
          return {
            zh: `把平台插件「${n.zh}」的范围改为 ${i.scope}${named}：${p.affected.length} 个组织将失去它`,
            en: `Change the scope of platform plugin "${n.en}" to ${i.scope}${namedEn}: ${p.affected.length} orgs lose it`,
          };
        },
        run: async (input, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, input.itemId, ctx.orgId);
          const target = {
            scope: input.scope,
            ...(input.orgs !== undefined && { orgs: input.orgs }),
          };
          return {
            item: await this.withoutPluginNames(input.itemId, target, () =>
              this.scope.setScope(
                ctx.actorAccountId,
                input.itemId,
                { ...target, scopeHash: input.scopeHash },
                { auditDetail: viaAgent("plugins.set-scope", ctx) },
              ),
            ),
          };
        },
      }),
      defineOperation({
        id: "plugins.set-disabled",
        description:
          "Disable a platform plugin everywhere, or enable it again (super admin). Disabling needs the scopeHash of plugins.scope-preview with disabled: true (the scope sync then removes it from every org; its scope and the org switches are kept); enabling needs none.",
        input: z
          .object({ itemId: ItemId, ...CatalogDisabledBody.shape })
          .strict()
          .refine((b) => !b.disabled || b.scopeHash !== undefined, {
            message:
              "scopeHash: required when disabling (plugins.scope-preview with disabled: true)",
            path: ["scopeHash"],
          }),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", disabled: false },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/catalog/items/:id/disabled"],
        renames: { itemId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id with plugins.platform-list.",
          },
          {
            code: "plugin.builtin",
            next: "A built-in plugin is on in every org; its scope cannot change and it cannot be disabled.",
          },
          {
            code: "plugin.scope_stale",
            next: "Call plugins.scope-preview again with the same target, show the new preview, and call again with its scopeHash.",
          },
        ],
        precheck: async (i, ctx) => {
          const other = await this.otherOrgs(i.itemId, ctx.orgId);
          if (other !== null) return other;
          if (!i.disabled) return this.live(i.itemId);
          let hash = "";
          const r = await precheckBy(async () => {
            hash = (await this.scope.preview(i.itemId, { disabled: true })).scopeHash;
          });
          if (!r.ok) return r;
          return hash === i.scopeHash
            ? { ok: true }
            : {
                ok: false,
                code: "plugin.scope_stale",
                message: "What disabling affects has changed since the preview",
              };
        },
        summary: async (i) => {
          const n = await this.names(i.itemId);
          if (!i.disabled) {
            return {
              zh: `在平台上重新启用插件「${n.zh}」`,
              en: `Enable platform plugin "${n.en}" again`,
            };
          }
          const p = await this.scope.preview(i.itemId, { disabled: true });
          return {
            zh: `在平台上停用插件「${n.zh}」：从 ${p.affected.length} 个组织移除`,
            en: `Disable platform plugin "${n.en}": removed from ${p.affected.length} orgs`,
          };
        },
        run: async (input, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, input.itemId, ctx.orgId);
          return {
            item: await this.withoutPluginNames(input.itemId, null, () =>
              this.scope.setDisabled(
                ctx.actorAccountId,
                input.itemId,
                {
                  disabled: input.disabled,
                  ...(input.scopeHash !== undefined && { scopeHash: input.scopeHash }),
                },
                { auditDetail: viaAgent("plugins.set-disabled", ctx) },
              ),
            ),
          };
        },
      }),
      defineOperation({
        id: "plugins.set-shown",
        description:
          "Show or hide a named platform plugin to the orgs outside its list (super admin): shown, they see it and can request it; hidden, they do not (pending requests stay). Never makes it usable anywhere. A plugin an org owns (shared or not) is managed by that org and refused here (the admin console still can).",
        input: z.object({ itemId: ItemId, ...CatalogShownBody.shape }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", shownToOthers: true },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/catalog/items/:id/shown"],
        renames: { itemId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id with plugins.platform-list.",
          },
          {
            code: "catalog.item_pending",
            next: "The plugin's first version waits for the super admin's confirmation in the admin console (Plugins → 待确认); confirm or reject it there first.",
          },
          {
            code: "catalog.org_owned",
            next: "An org owns this plugin and manages who sees it; leave it to that org, or use the admin console.",
          },
        ],
        precheck: async (i, ctx) => {
          const other = await this.otherOrgs(i.itemId, ctx.orgId);
          if (other !== null) return other;
          if (await this.orgOwned(i.itemId)) {
            return { ok: false, code: "catalog.org_owned", message: ORG_OWNED };
          }
          return this.live(i.itemId);
        },
        summary: async (i) => {
          const n = await this.names(i.itemId);
          return i.shownToOthers
            ? {
                zh: `向名单外的组织展示平台插件「${n.zh}」（可申请）`,
                en: `Show platform plugin "${n.en}" to orgs outside its list (requestable)`,
              }
            : {
                zh: `对名单外的组织隐藏平台插件「${n.zh}」`,
                en: `Hide platform plugin "${n.en}" from orgs outside its list`,
              };
        },
        run: async (input, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, input.itemId, ctx.orgId);
          if (await this.orgOwned(input.itemId)) throw new ToolError(ORG_OWNED);
          return {
            item: await this.scope.setShown(ctx.actorAccountId, input.itemId, input.shownToOthers, {
              auditDetail: viaAgent("plugins.set-shown", ctx),
            }),
          };
        },
      }),
      defineOperation({
        id: "plugins.delete",
        description:
          "Delete a platform catalog plugin (super admin): it leaves the catalog and its pending requests are cancelled; what orgs installed from it stays installed. To take it away from orgs, use plugins.set-disabled or plugins.set-scope instead.",
        input: z.object({ itemId: ItemId }).strict(),
        example: { itemId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" },
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/catalog/items/:id"],
        renames: { itemId: "id" },
        confirm: "platform",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "Check the plugin id with plugins.platform-list.",
          },
        ],
        precheck: async (i, ctx) =>
          (await this.otherOrgs(i.itemId, ctx.orgId)) ?? this.live(i.itemId),
        summary: async (i) => {
          const { item } = await this.catalog.get(i.itemId);
          const n = localized(item.displayName, item.name);
          return {
            zh: `从平台目录删除插件「${n.zh}」（${item.enabledOrgs} 个组织中已安装的内容保留）`,
            en: `Delete plugin "${n.en}" from the platform catalog (what ${item.enabledOrgs} orgs installed stays)`,
          };
        },
        run: async (input, ctx) => {
          await assertNotOtherOrgs(this.kdb.db, input.itemId, ctx.orgId);
          await this.catalog.remove(ctx.actorAccountId, input.itemId, {
            auditDetail: viaAgent("plugins.delete", ctx),
          });
          return { deleted: input.itemId };
        },
      }),
    ]);
  }
}
