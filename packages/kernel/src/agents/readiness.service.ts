import {
  type LocalizedName,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  parseExtensionPoint,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import {
  OrgExtensionConfigs,
  type OrgExtensionView,
  providesOf,
} from "../extensions/org-config.js";
import { type ListErrorKind, ProviderRegistry } from "../runtime/providers.js";
import { AgentsService } from "./agents.service.js";

/**
 * A model provider an org admin can make usable on `/settings/models`, and what it waits for:
 * `not_enabled`, the org has not switched it on (it may also need the org's config then);
 * `needs_config`, it is on but waits for the org's own copy of an overridable deployment field
 * the platform left empty.
 */
export interface OrgFixableProvider {
  provider: string;
  reason: "not_enabled" | "needs_config";
}

/**
 * A model provider that is on in the org with a valid config but gives an agent no model to pick
 * (readiness `no_models`): `list_failed`, its model list failed (`errorKind`, the provider's
 * `ModelError` kind, `timeout` when the kernel's list time limit passed, else `unknown`);
 * `no_chat_models`, it lists but no chat model is on in the org. `orgCanFix`: an org admin can fix
 * it on `/settings/models` (`list_failed`: the org can hold its own copy of the provider's config,
 * a key among it; `no_chat_models`: a chat model the platform left on is off in the org); else
 * only the super admin can (`/admin/models`).
 */
export type UnusableProvider = {
  provider: string;
  /** The provider extension's display name; null when it has none (show the id). */
  displayName: LocalizedName | null;
  orgCanFix: boolean;
} & ({ reason: "list_failed"; errorKind: ListErrorKind } | { reason: "no_chat_models" });

/** What `GET /orgs/:orgId/readiness` and the `agents.readiness` operation answer. */
export interface OrgReadiness {
  /**
   * `ready`: the org has a chat model an agent can pick (the agent form's list:
   * `GET /orgs/:orgId/models?kind=chat`); `no_models`: providers are on with a valid config but
   * none gives one (`unusableProviders` says why for each); `org_fixable`: no provider is on with a
   * valid config, but an org admin can make one so (`orgFixableProviders`); `none`: only the super
   * admin can help (no provider loaded on the deployment that the org may use).
   */
  modelProvider: "ready" | "no_models" | "org_fixable" | "none";
  /**
   * With `org_fixable`, the providers an org admin can fix here; with `no_models`, the other
   * providers an org admin could switch on or configure (empty otherwise).
   */
  orgFixableProviders: OrgFixableProvider[];
  /** With `no_models`, the providers that are on but give no model, and why (empty otherwise). */
  unusableProviders: UnusableProvider[];
  /** The agents the caller can see (the agent list's visibility). */
  agents: number;
}

const MODEL_PROVIDER = parseExtensionPoint(MODEL_PROVIDER_EXTENSION_POINT_V2).name;

const isModelProvider = (v: OrgExtensionView) =>
  providesOf(v).some((ref) => parseExtensionPoint(ref).name === MODEL_PROVIDER);

/** The org can fill the config the extension waits for: it has an overridable field. */
const orgCanConfigure = (v: OrgExtensionView) => v.configurable;

/**
 * What the org admin must do to make `v` usable here, or null when they cannot (or need not). The
 * view comes from the org's extension list, which shows an extension only when it is offered to
 * the org (`offeredToOrg`): not named to other orgs only, not disabled while off.
 */
export function fixOf(v: OrgExtensionView): OrgFixableProvider["reason"] | null {
  if (!v.available) return null;
  if (!v.enabled)
    return v.switchable && (!v.needsConfig || orgCanConfigure(v)) ? "not_enabled" : null;
  return v.needsConfig && orgCanConfigure(v) ? "needs_config" : null;
}

/**
 * Whether the org can run (web-order spec §3.8), the one place it is computed (the readiness
 * route and the `agents.readiness` operation): the web app decides between the shell and the setup
 * layout with it, and the setup checklist sends the org's admins to `/settings/models` while the
 * model step is `org_fixable` (or `no_models` that the org can fix). First the cheap gate, this
 * replica's provider registry (`hasProvider`: extension state, switches and config, no vendor
 * call; a replica that has not reconciled a just-enabled provider answers otherwise for a
 * moment); past it, the providers' model lists as the agent form reads them
 * (`ProviderRegistry.chatUsability`: the shared list cache, the list time limit and the failure
 * markers bound the call). The fixable providers come from the org's extension list.
 */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(OrgExtensionConfigs) private readonly configs: OrgExtensionConfigs,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
  ) {}

  async get(orgId: string, viewer: string | null): Promise<OrgReadiness> {
    const [gate, visible] = await Promise.all([
      this.registry.hasProvider(orgId),
      this.agents.listVisible(orgId, viewer),
    ]);
    const usability = gate ? await this.registry.chatUsability(orgId) : [];
    if (usability.some((u) => u.state === "usable")) {
      return {
        modelProvider: "ready",
        orgFixableProviders: [],
        unusableProviders: [],
        agents: visible.length,
      };
    }
    const views = await this.configs.list(orgId);
    const fixable = orgFixableOf(views);
    if (gate) {
      return {
        modelProvider: "no_models",
        orgFixableProviders: fixable,
        unusableProviders: await this.unusable(usability, views),
        agents: visible.length,
      };
    }
    return {
      modelProvider: fixable.length > 0 ? "org_fixable" : "none",
      orgFixableProviders: fixable,
      unusableProviders: [],
      agents: visible.length,
    };
  }

  private async unusable(
    usability: Awaited<ReturnType<ProviderRegistry["chatUsability"]>>,
    views: OrgExtensionView[],
  ): Promise<UnusableProvider[]> {
    const byPlugin = new Map(views.map((v) => [v.plugin, v]));
    const names = await this.displayNames.many(usability.map((u) => u.provider));
    const out: UnusableProvider[] = [];
    for (const u of usability) {
      const base = { provider: u.provider, displayName: names.get(u.provider) ?? null };
      if (u.state === "list_failed") {
        const v = byPlugin.get(u.provider);
        const orgCanFix = v !== undefined && orgCanConfigure(v);
        out.push({ ...base, orgCanFix, reason: "list_failed", errorKind: u.errorKind });
      } else if (u.state === "no_chat_models") {
        out.push({ ...base, orgCanFix: u.orgCanEnable, reason: "no_chat_models" });
      }
    }
    return out;
  }
}

function orgFixableOf(views: OrgExtensionView[]): OrgFixableProvider[] {
  const out: OrgFixableProvider[] = [];
  for (const v of views) {
    if (!isModelProvider(v)) continue;
    const reason = fixOf(v);
    if (reason !== null) out.push({ provider: v.plugin, reason });
  }
  return out;
}
