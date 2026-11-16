import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import {
  OrgExtensionConfigs,
  type OrgExtensionInput,
  type OrgExtensionView,
} from "../extensions/org-config.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
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
 * Order: the config is validated first (`validateOnly`: no side effect), so an invalid config fails
 * before the plugin switches with the plain 400 `extension.config_invalid`. Switching on validates
 * the effective config (the stored one with its secrets, or the given `config` merged with them),
 * and the install receives the given `config` as its `extensionConfig`, so the extension is enabled
 * with it. A config write that fails for another reason after the switch succeeded returns that
 * error in the same transaction as the switch, so the switch stays as it was (a fresh install is the
 * exception: it commits on its own and carries the config itself).
 */
@Injectable()
export class OrgExtensionSwitch {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OrgExtensionConfigs) private readonly configs: OrgExtensionConfigs,
    @Inject(OrgCatalogService) private readonly catalog: OrgCatalogService,
  ) {}

  /**
   * - `enabled` on an extension of one catalog plugin: that plugin's switch; off without `confirm`
   *   returns the preview and its hash, with the hash uninstalls; a builtin plugin (any of several
   *   source items) -> 409 `plugin.scope_locked` (an `all` one may go off, layering spec §4).
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
        "This plugin is built in: it is on for every organization and cannot be switched off here",
      );
    }
    if (plan.kind === "direct") {
      return {
        kind: "done",
        view: await this.configs.put(orgId, extension, input, actor, actorTokenId),
      };
    }
    const { enabled } = input;
    const config = input.config !== undefined ? { config: input.config } : {};
    // Fail before the switch when the config would be refused: switching on checks the effective
    // config (a required field never saved is refused here, not as a failed install)
    if (enabled || input.config !== undefined) {
      await this.configs.put(
        orgId,
        extension,
        { ...config, ...(enabled && { enabled: true }) },
        actor,
        actorTokenId,
        { validateOnly: true },
      );
    }
    // A fresh install is a multi-step saga that commits on its own and already enables the
    // extension with the given config (`extensionConfig`): no transaction spans it, and no second
    // config write follows. Everything else (the switch row, an uninstall, the config write) is one
    // transaction: a failing config write leaves the switch as it was.
    const installing = enabled === true && !(await this.catalog.hasLiveInstall(orgId, plan.itemId));
    const args = {
      orgId,
      actor,
      extension,
      itemId: plan.itemId,
      enabled,
      input,
      confirm,
      actorTokenId,
    };
    const r = await (installing ? this.apply(args, true) : this.applyAtomic(args));
    if (r !== "readBack") return r;
    // Read after the commit: the list reads its own snapshot, which sees only committed rows
    const view = (await this.configs.list(orgId)).find((v) => v.plugin === extension);
    if (view) return { kind: "done", view };
    return {
      kind: "done",
      view: await this.configs.put(orgId, extension, { enabled: true }, actor, actorTokenId, {
        ifDisabled: { skipped: false },
      }),
    };
  }

  @Transactional()
  private applyAtomic(a: ApplyArgs): Promise<OrgExtensionPutResult | "readBack"> {
    return this.apply(a, false);
  }

  private async apply(
    a: ApplyArgs,
    installing: boolean,
  ): Promise<OrgExtensionPutResult | "readBack"> {
    const { orgId, actor, extension, itemId, enabled, input, confirm, actorTokenId } = a;
    const r = await this.catalog
      .setSwitch(
        orgId,
        actor,
        itemId,
        enabled
          ? {
              enabled: true,
              ...(input.config !== undefined && { inputs: { extensionConfig: input.config } }),
            }
          : { enabled: false, ...(confirm !== undefined && { confirm }) },
        actorTokenId,
      )
      .catch((e: unknown) => {
        throw configInvalidOf(e) ?? e;
      });
    if (r.kind === "preview") return r;
    if (input.config === undefined) {
      if (!enabled) {
        return "readBack";
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
        installing ? { ifDisabled: { skipped: false } } : undefined,
      ),
    };
  }
}

interface ApplyArgs {
  orgId: string;
  actor: string;
  extension: string;
  itemId: string;
  enabled: boolean | undefined;
  input: OrgExtensionInput;
  confirm: string | undefined;
  actorTokenId: string | undefined;
}

/**
 * An install that failed only at its own extension step on the org config (it was valid when
 * checked, then changed concurrently): the plain 400 `extension.config_invalid` with the field
 * issues, as when saving the config; the install was rolled back. Anything else: undefined.
 */
function configInvalidOf(e: unknown): ApiError | undefined {
  if (!(e instanceof ApiError) || e.code !== "plugin.install_failed") return undefined;
  const [d] = (e.details ?? []) as {
    step?: string;
    code?: string;
    dependency?: string;
    message?: string;
    causeDetails?: unknown[];
    rolledBack?: boolean;
  }[];
  if (d?.step !== "extension" || d.code !== "extension.config_invalid") return undefined;
  if (d.dependency !== undefined || d.rolledBack !== true) return undefined;
  return new ApiError(
    "extension.config_invalid",
    d.message ?? "Invalid organization config",
    d.causeDetails,
  );
}
