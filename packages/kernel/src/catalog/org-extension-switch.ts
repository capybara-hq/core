import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import {
  OrgExtensionConfigs,
  type OrgExtensionInput,
  type OrgExtensionView,
} from "../extensions/org-config.js";
import { OrgCatalogService } from "./org-catalog.service.js";
import type { UninstallPreview } from "./plugin-install.js";

/** The result of {@link OrgExtensionSwitch.put}: the extension, or the plugin uninstall preview. */
export type OrgExtensionPutResult =
  | { kind: "done"; view: OrgExtensionView }
  | { kind: "preview"; preview: UninstallPreview; confirm: string };

/**
 * `PUT orgs/:orgId/extensions/:extension`: for an extension that ships in a catalog plugin, `enabled`
 * is the plugin's org switch ({@link OrgCatalogService.setSwitch}); anything else is the direct
 * {@link OrgExtensionConfigs.put}. Lives in the catalog module because the catalog depends on the
 * extensions, not the other way round. No in-process state.
 *
 * Order: a `config` is validated first (`validateOnly`: no side effect), so an invalid config fails
 * before the plugin switches. A config write that fails for another reason after the switch
 * succeeded returns that error with the switch done (the two writes are separate transactions).
 */
@Injectable()
export class OrgExtensionSwitch {
  constructor(
    @Inject(OrgExtensionConfigs) private readonly configs: OrgExtensionConfigs,
    @Inject(OrgCatalogService) private readonly catalog: OrgCatalogService,
  ) {}

  /**
   * - `enabled` on an extension of one catalog plugin: that plugin's switch; off without `confirm`
   *   returns the preview and its hash, with the hash uninstalls; an `all` or builtin plugin (any of
   *   several source items) -> 409 `plugin.scope_locked`.
   * - A required bootstrap plugin, a config-declared extension and one sourced from several items
   *   keep the direct write.
   * - `config` is always written directly, after the switch.
   */
  async put(
    orgId: string,
    actor: string,
    extension: string,
    body: OrgExtensionInput & { confirm?: string | undefined },
    actorTokenId?: string,
  ): Promise<OrgExtensionPutResult> {
    const { confirm, ...input } = body;
    const plan =
      input.enabled === undefined
        ? ({ kind: "direct" } as const)
        : await this.configs.switchPlan(extension, input.enabled);
    if (plan.kind === "locked") {
      throw new ApiError(
        "plugin.scope_locked",
        "This plugin is on for every organization and cannot be switched off here",
      );
    }
    if (plan.kind === "direct") {
      return {
        kind: "done",
        view: await this.configs.put(orgId, extension, input, actor, actorTokenId),
      };
    }
    const { enabled } = input;
    // Fail before the switch when the config would be refused
    if (input.config !== undefined) {
      await this.configs.put(orgId, extension, { config: input.config }, actor, actorTokenId, {
        validateOnly: true,
      });
    }
    const r = await this.catalog.setSwitch(
      orgId,
      actor,
      plan.itemId,
      enabled ? { enabled: true } : { enabled: false, ...(confirm !== undefined && { confirm }) },
      actorTokenId,
    );
    if (r.kind === "preview") return r;
    if (input.config === undefined) {
      if (!enabled) {
        const view = (await this.configs.list(orgId)).find((v) => v.plugin === extension);
        if (view) return { kind: "done", view };
      }
      // Switching on: the install enabled it already (no second write)
      return {
        kind: "done",
        view: await this.configs.put(orgId, extension, { enabled: true }, actor, actorTokenId, {
          ifDisabled: { skipped: false },
        }),
      };
    }
    return {
      kind: "done",
      view: await this.configs.put(
        orgId,
        extension,
        { config: input.config, ...(enabled && { enabled: true }) },
        actor,
        actorTokenId,
      ),
    };
  }
}
