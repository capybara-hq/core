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
 * extensions, not the other way round. No in-process state. Switching never checks a config: an
 * extension whose effective config is not valid in the org is switched on and reported
 * `needsConfig` (spec A §6).
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
   */
  async put(
    orgId: string,
    actor: string,
    extension: string,
    body: OrgExtensionInput & { confirm?: string | undefined },
    actorTokenId?: string,
    /** Merged into the audit details (a Platform operation's `via: "agent"`). */
    auditDetail?: Record<string, unknown>,
  ): Promise<OrgExtensionPutResult> {
    const { confirm, ...input } = body;
    const audited = auditDetail !== undefined ? { auditDetail } : {};
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
        view: await this.configs.put(orgId, extension, input, actor, actorTokenId, audited),
      };
    }
    const { enabled } = input;
    // A fresh install is a multi-step saga that commits on its own and already enables the
    // extension: no transaction spans it. Everything else (the switch row, an uninstall, reading
    // the result back) is one transaction.
    const installing = enabled === true && !(await this.catalog.hasLiveInstall(orgId, plan.itemId));
    const args = {
      orgId,
      actor,
      extension,
      itemId: plan.itemId,
      enabled,
      confirm,
      actorTokenId,
      auditDetail,
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
        ...audited,
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
    const { orgId, actor, extension, itemId, enabled, confirm, actorTokenId, auditDetail } = a;
    const audited = auditDetail !== undefined ? { auditDetail } : {};
    // Switching on inside the transaction relies on the live install seen before it: one removed
    // meanwhile would run the install saga here, which commits on its own. Refuse instead; the
    // retry takes the install path.
    if (!installing && enabled === true && !(await this.catalog.hasLiveInstall(orgId, itemId))) {
      throw new ApiError(
        "conflict",
        "The plugin's install in this organization changed while it was being switched on; try again",
      );
    }
    const r = await this.catalog.setSwitch(
      orgId,
      actor,
      itemId,
      enabled ? { enabled: true } : { enabled: false, ...(confirm !== undefined && { confirm }) },
      actorTokenId,
      auditDetail,
    );
    if (r.kind === "preview") return r;
    if (!enabled) return "readBack";
    // Switching on: the install enabled it already (no second write)
    return {
      kind: "done",
      view: await this.configs.put(orgId, extension, { enabled: true }, actor, actorTokenId, {
        ifDisabled: { skipped: false },
        ...audited,
      }),
    };
  }
}

interface ApplyArgs {
  orgId: string;
  actor: string;
  extension: string;
  itemId: string;
  enabled: boolean | undefined;
  confirm: string | undefined;
  actorTokenId: string | undefined;
  auditDetail: Record<string, unknown> | undefined;
}
