import type { LocalizedName, SuggestedAppearance } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { type ClientBuildSummary, ClientBuilds } from "../client/client-builds.service.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import {
  OrgExtensionConfigs,
  type OrgExtensionView,
  providesOf,
} from "../extensions/org-config.js";
import { OrgOverrides, type OrgOverrideView } from "../extensions/org-overrides.js";
import { orgIconScope, PluginIcons } from "../extensions/plugin-icons.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { roleAtLeast } from "../orgs/roles.js";
import {
  type OrgToolSwitch,
  OrgToolSwitches,
  type OrgToolSwitchResult,
} from "../tools/org-tool-switches.js";
import { AppearanceApplyBody } from "./appearance.schemas.js";
import { type AppearanceResult, AppearanceService } from "./appearance.service.js";
import {
  OrgExtensionParams as ExtensionParams,
  OrgExtensionToolParams as ToolParams,
  OrgToolSwitchPut as ToolSwitchPut,
} from "./org-extension.schemas.js";
import { OrgExtensionSwitch } from "./org-extension-switch.js";
import type { UninstallPreview } from "./plugin-install.js";

const PutBody = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    force: z.boolean().optional(),
    /** The hash of the plugin uninstall preview, to confirm switching the extension's plugin off. */
    confirm: z.string().optional(),
  })
  .strict();

class OrgExtensionPutBody extends createZodDto(PutBody, "OrgExtensionPutBody") {}

const OverrideSecretEntry = z
  .object({
    /** A secret record field of the copy some `x-ui.secrets[].path` names. */
    path: z.string().min(1).max(256),
    key: z.string().min(1).max(256),
    /** A string sets the key, `null` removes it. */
    value: z.string().max(65_536).nullable().optional(),
    /** Moves the value at this key to `key` first. */
    renameFrom: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((e) => e.value !== undefined || e.renameFrom !== undefined, {
    message: "an entry needs value or renameFrom",
  })
  .refine((e) => e.key !== "__proto__" && e.renameFrom !== "__proto__", {
    message: "__proto__ is not a valid key",
  });

const OverridesPut = z
  .object({
    /** Overridable field dot path -> new value (`null` clears); secret fields too. */
    values: z.record(z.string().min(1).max(256), z.unknown()),
    secretEntries: z.array(OverrideSecretEntry).max(200).optional(),
  })
  .strict();

const OverridesTake = z
  .object({ paths: z.array(z.string().min(1).max(256)).min(1).max(200) })
  .strict();

class OrgToolSwitchPutBody extends createZodDto(ToolSwitchPut, "OrgToolSwitchPutBody") {}

class OrgExtensionParamsDto extends createZodDto(ExtensionParams, "OrgExtensionParams") {}
class OrgExtensionToolParamsDto extends createZodDto(ToolParams, "OrgExtensionToolParams") {}

class OrgAppearanceApplyBody extends createZodDto(AppearanceApplyBody, "OrgAppearanceApplyBody") {}

class OrgOverridesPutBody extends createZodDto(OverridesPut, "OrgOverridesPutBody") {}
class OrgOverridesTakeBody extends createZodDto(OverridesTake, "OrgOverridesTakeBody") {}

/**
 * One extension of the org list: the org view plus the plugin's display name, the URL of its
 * plugin's icon on the org's catalog route (null without one or when the org may not see the
 * plugin's item), the extension points it provides (`channel@1`, `web-search@1`, … the names
 * only, also for members), the plugin's suggested appearance (null without one; the page offers
 * 应用此插件的外观 to org admins when set, client extensions spec §6.5) and the client build of the
 * running package (files with sizes, total, client API version; null without one: the permission
 * review's 客户端代码 group, spec §5.4).
 */
export type OrgExtensionItem = OrgExtensionView & {
  displayName: LocalizedName | null;
  icon: string | null;
  provides: string[];
  suggestedAppearance: SuggestedAppearance | null;
  client: ClientBuildSummary | null;
};

/**
 * What a member sees of an extension: its state and the points it provides (names only, what the
 * 扩展 page sorts by), never the org config, the secrets' state, the config schema, the
 * permission list, the suggested appearance (members cannot apply it) or the client build (part of
 * the permission review).
 */
export type OrgExtensionMemberItem = Omit<
  OrgExtensionItem,
  "config" | "secrets" | "orgConfigSchema" | "permissions" | "suggestedAppearance" | "client"
>;

/**
 * Org-level extension enablement and config (`/api/v1/orgs/:orgId/extensions`); responses echo only
 * non-secret config and whether each secret is set.
 */
@Controller("api/v1/orgs/:orgId/extensions")
export class OrgExtensionConfigsController {
  constructor(
    @Inject(OrgExtensionConfigs) private readonly configs: OrgExtensionConfigs,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(OrgExtensionSwitch) private readonly extSwitch: OrgExtensionSwitch,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
    @Inject(AppearanceService) private readonly appearance: AppearanceService,
    @Inject(ClientBuilds) private readonly clientBuilds: ClientBuilds,
  ) {}

  /**
   * The org's extensions (also the channel plugin options: those providing `channel@1`). Members
   * get the projection {@link OrgExtensionMemberItem}; admins the full view.
   */
  @Get()
  @OrgAction("org.extensions.read")
  async list(
    @CurrentOrg() org: OrgContext,
  ): Promise<{ extensions: OrgExtensionItem[] | OrgExtensionMemberItem[] }> {
    const views = await this.configs.list(org.orgId);
    const plugins = views.map((v) => v.plugin);
    const admin = roleAtLeast(org.role, "admin");
    const [names, icons, suggestions, clients] = await Promise.all([
      this.displayNames.many(plugins),
      this.icons.many(plugins, orgIconScope(org)),
      admin ? this.appearance.suggestions(plugins) : new Map<string, SuggestedAppearance | null>(),
      admin ? this.clientBuilds.installedSummaries(plugins) : new Map<string, ClientBuildSummary>(),
    ]);
    const items = views.map((v) => ({
      ...v,
      displayName: names.get(v.plugin) ?? null,
      icon: icons.get(v.plugin) ?? null,
      provides: providesOf(v),
      suggestedAppearance: suggestions.get(v.plugin) ?? null,
      client: clients.get(v.plugin) ?? null,
    }));
    if (admin) return { extensions: items };
    return {
      extensions: items.map(
        ({
          config: _c,
          secrets: _s,
          orgConfigSchema: _o,
          permissions: _p,
          suggestedAppearance: _a,
          client: _cl,
          ...rest
        }) => rest,
      ),
    };
  }

  /**
   * Writes enablement and / or config; see {@link OrgExtensionSwitch.put} for how `enabled` follows
   * the extension's plugin (off answers `{ preview, confirm }` until `confirm` carries the hash).
   */
  @Put(":extension")
  @OrgAction("org.extensions.manage")
  async put(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("extension") extension: string,
    @ZBody(OrgExtensionPutBody) body: z.infer<typeof PutBody>,
  ): Promise<{ extension: OrgExtensionItem } | { preview: UninstallPreview; confirm: string }> {
    const p = requireUser(principal);
    const r = await this.extSwitch.put(org.orgId, p.account.id, extension, body, patTokenId(p));
    if (r.kind === "preview") return { preview: r.preview, confirm: r.confirm };
    const [displayName, icons, suggestions, clients] = await Promise.all([
      this.displayNames.get(r.view.plugin),
      this.icons.many([r.view.plugin], orgIconScope(org)),
      this.appearance.suggestions([r.view.plugin]),
      this.clientBuilds.installedSummaries([r.view.plugin]),
    ]);
    return {
      extension: {
        ...r.view,
        displayName,
        icon: icons.get(r.view.plugin) ?? null,
        provides: providesOf(r.view),
        suggestedAppearance: suggestions.get(r.view.plugin) ?? null,
        client: clients.get(r.view.plugin) ?? null,
      },
    };
  }

  /**
   * 应用此插件的外观 (client extensions spec §6.5), for a plugin whose extension is on in the org:
   * sets the plugin's suggested theme as the org's default theme (keeping `personal`) and each
   * suggested replacement as the org arrangement's `use` of its slot, in one transaction.
   * `dryRun: true` answers the same changes and writes nothing. A theme not on in the org -> 400
   * `theme.not_available` (nothing written); a replacement not available in the org is skipped.
   * An extension not on in the org, or a plugin without a suggestion -> 404 `extension.not_found`.
   */
  @Post(":extension/appearance")
  @HttpCode(200)
  @OrgAction("org.update")
  applyAppearance(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgExtensionParamsDto) { extension }: z.infer<typeof ExtensionParams>,
    @ZBody(OrgAppearanceApplyBody) body: z.infer<typeof AppearanceApplyBody>,
  ): Promise<AppearanceResult> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return this.appearance.apply(
      { orgId: org.orgId },
      extension,
      { accountId: p.account.id, ...(tokenId !== undefined && { tokenId }) },
      body.dryRun === true,
    );
  }
}

/**
 * The org's two-level deployment config of an extension (spec A §5.3 to §5.6): following or a copy,
 * the read-only and overridable fields (hidden ones are never sent), secrets as set or not.
 */
@Controller("api/v1/orgs/:orgId/extensions/:extension/overrides")
export class OrgExtensionOverridesController {
  constructor(@Inject(OrgOverrides) private readonly overrides: OrgOverrides) {}

  @Get()
  @OrgAction("org.extensions.manage")
  view(
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgExtensionParamsDto) { extension }: z.infer<typeof ExtensionParams>,
  ): Promise<OrgOverrideView> {
    return this.overrides.view(org.orgId, extension);
  }

  /**
   * Saves overridable fields; the first save makes the copy, which must be valid on its own (the
   * org's own secrets in the same save). A read-only, hidden or unknown field -> 400
   * `extension.field_not_overridable`; invalid -> 400 `extension.config_invalid`.
   */
  @Put()
  @OrgAction("org.extensions.manage")
  save(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgExtensionParamsDto) { extension }: z.infer<typeof ExtensionParams>,
    @ZBody(OrgOverridesPutBody) body: z.infer<typeof OverridesPut>,
  ): Promise<OrgOverrideView> {
    const p = requireUser(principal);
    return this.overrides.save(org.orgId, extension, body.values, body.secretEntries ?? [], {
      accountId: p.account.id,
      tokenId: patTokenId(p),
    });
  }

  /** Drops the copy (its secrets too): the org follows the platform again. */
  @Delete()
  @OrgAction("org.extensions.manage")
  reset(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgExtensionParamsDto) { extension }: z.infer<typeof ExtensionParams>,
  ): Promise<OrgOverrideView> {
    const p = requireUser(principal);
    return this.overrides.reset(org.orgId, extension, {
      accountId: p.account.id,
      tokenId: patTokenId(p),
    });
  }

  /** Takes the platform's current values of non-secret overridable fields into the copy. */
  @Post("take")
  @HttpCode(200)
  @OrgAction("org.extensions.manage")
  take(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgExtensionParamsDto) { extension }: z.infer<typeof ExtensionParams>,
    @ZBody(OrgOverridesTakeBody) body: z.infer<typeof OverridesTake>,
  ): Promise<OrgOverrideView> {
    const p = requireUser(principal);
    return this.overrides.take(org.orgId, extension, body.paths, {
      accountId: p.account.id,
      tokenId: patTokenId(p),
    });
  }
}

/**
 * The org's switches of an extension's single tools (layering spec A §7): members read them, org
 * admins turn a tool off (previewed with the agents that selected it, PCM §5 rule 8) or on.
 */
@Controller("api/v1/orgs/:orgId/extensions/:extension/tools")
export class OrgExtensionToolSwitchesController {
  constructor(@Inject(OrgToolSwitches) private readonly switches: OrgToolSwitches) {}

  /** Every tool the extension registers, with its switch (on unless the org turned it off). */
  @Get()
  @OrgAction("org.extensions.read")
  async list(
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgExtensionParamsDto) { extension }: z.infer<typeof ExtensionParams>,
  ): Promise<{ tools: OrgToolSwitch[] }> {
    return { tools: await this.switches.list(org.orgId, extension) };
  }

  /**
   * Switches one tool: on applies at once; off answers `{ applied: false, affectedAgents, confirm }`
   * until `confirm` carries the hash (a changed preview -> 409 `plugin.switch_stale`). A tool the
   * extension does not register -> 404 `extension.tool_not_found`.
   */
  @Put(":tool")
  @OrgAction("org.extensions.manage")
  set(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgExtensionToolParamsDto) { extension, tool }: z.infer<typeof ToolParams>,
    @ZBody(OrgToolSwitchPutBody) body: z.infer<typeof ToolSwitchPut>,
  ): Promise<OrgToolSwitchResult> {
    const p = requireUser(principal);
    return this.switches.set(
      org.orgId,
      extension,
      tool,
      body.enabled,
      { accountId: p.account.id, tokenId: patTokenId(p) },
      body.confirm,
    );
  }
}
