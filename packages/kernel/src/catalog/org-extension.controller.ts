import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { OrgExtensionConfigs, type OrgExtensionView } from "../extensions/org-config.js";
import { OrgOverrides, type OrgOverrideView } from "../extensions/org-overrides.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { roleAtLeast } from "../orgs/roles.js";
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

class OrgOverridesPutBody extends createZodDto(OverridesPut, "OrgOverridesPutBody") {}
class OrgOverridesTakeBody extends createZodDto(OverridesTake, "OrgOverridesTakeBody") {}

/**
 * One extension of the org list: the org view plus the plugin's display name and the extension
 * points it provides (`channel@1`, `web-search@1`, … the names only, also for members).
 */
export type OrgExtensionItem = OrgExtensionView & {
  displayName: LocalizedName | null;
  provides: string[];
};

/**
 * What a member sees of an extension: its state and the points it provides (names only, what the
 * 扩展 page sorts by), never the org config, the secrets' state, the config schema or the
 * permission list.
 */
export type OrgExtensionMemberItem = Omit<
  OrgExtensionItem,
  "config" | "secrets" | "orgConfigSchema" | "permissions"
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
    const names = await this.displayNames.many(views.map((v) => v.plugin));
    const items = views.map((v) => ({
      ...v,
      displayName: names.get(v.plugin) ?? null,
      provides: providesOf(v),
    }));
    if (roleAtLeast(org.role, "admin")) return { extensions: items };
    return {
      extensions: items.map(
        ({ config: _c, secrets: _s, orgConfigSchema: _o, permissions: _p, ...rest }) => rest,
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
    return {
      extension: {
        ...r.view,
        displayName: await this.displayNames.get(r.view.plugin),
        provides: providesOf(r.view),
      },
    };
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
    @Param("extension") extension: string,
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
    @Param("extension") extension: string,
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
    @Param("extension") extension: string,
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
    @Param("extension") extension: string,
    @ZBody(OrgOverridesTakeBody) body: z.infer<typeof OverridesTake>,
  ): Promise<OrgOverrideView> {
    const p = requireUser(principal);
    return this.overrides.take(org.orgId, extension, body.paths, {
      accountId: p.account.id,
      tokenId: patTokenId(p),
    });
  }
}

/** The extension points an extension provides, from its permission list's `provides` group. */
function providesOf(view: OrgExtensionView): string[] {
  return view.permissions.filter((g) => g.category === "provides").flatMap((g) => g.items);
}
