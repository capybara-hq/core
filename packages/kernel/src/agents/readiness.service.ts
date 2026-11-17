import { MODEL_PROVIDER_EXTENSION_POINT_V2, parseExtensionPoint } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import {
  OrgExtensionConfigs,
  type OrgExtensionView,
  providesOf,
} from "../extensions/org-config.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { AgentsService } from "./agents.service.js";

/**
 * A model provider an org admin can make usable on `/settings/models`, and what it waits for:
 * `not_enabled`, the org has not switched it on (it may also need the org's config then);
 * `needs_config`, it is on but waits for the org's own config (an org-level field, or an
 * overridable platform field the platform left empty).
 */
export interface OrgFixableProvider {
  provider: string;
  reason: "not_enabled" | "needs_config";
}

/** What `GET /orgs/:orgId/readiness` and the `agents.readiness` operation answer. */
export interface OrgReadiness {
  /**
   * `ready`: a model provider is usable in the org (extension state only, never a vendor call);
   * `org_fixable`: none is, but an org admin can make one usable (`orgFixableProviders`); `none`:
   * only the super admin can help (no provider loaded on the deployment that the org may use).
   */
  modelProvider: "ready" | "org_fixable" | "none";
  /** With `org_fixable`, the providers an org admin can fix here (empty otherwise). */
  orgFixableProviders: OrgFixableProvider[];
  /** The agents the caller can see (the agent list's visibility). */
  agents: number;
}

const MODEL_PROVIDER = parseExtensionPoint(MODEL_PROVIDER_EXTENSION_POINT_V2).name;

const isModelProvider = (v: OrgExtensionView) =>
  providesOf(v).some((ref) => parseExtensionPoint(ref).name === MODEL_PROVIDER);

/** The org can fill the config the extension waits for: an org-level or an overridable field. */
const orgCanConfigure = (v: OrgExtensionView) => v.configurable || v.overrideState !== "none";

/**
 * What the org admin must do to make `v` usable here, or null when they cannot (or need not). The
 * view comes from the org's extension list, which shows an extension only when it is offered to
 * the org (`offeredToOrg`): not named to other orgs only, not disabled while off.
 */
function fixOf(v: OrgExtensionView): OrgFixableProvider["reason"] | null {
  if (!v.available) return null;
  if (!v.enabled)
    return v.switchable && (!v.needsConfig || orgCanConfigure(v)) ? "not_enabled" : null;
  return v.needsConfig && orgCanConfigure(v) ? "needs_config" : null;
}

/**
 * Whether the org can run (web-order spec §3.8), the one place it is computed (the readiness
 * route and the `agents.readiness` operation): the web app decides between the shell and the setup
 * layout with it, and the setup checklist sends the org's admins to `/settings/models` while the
 * model step is `org_fixable`. `ready` reads this replica's provider registry (a replica that has
 * not reconciled a just-enabled provider answers otherwise for a moment); the fixable providers
 * come from the org's extension list.
 */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(OrgExtensionConfigs) private readonly configs: OrgExtensionConfigs,
    @Inject(AgentsService) private readonly agents: AgentsService,
  ) {}

  async get(orgId: string, viewer: string | null): Promise<OrgReadiness> {
    const [ready, visible] = await Promise.all([
      this.registry.hasProvider(orgId),
      this.agents.listVisible(orgId, viewer),
    ]);
    const fixable = ready ? [] : await this.orgFixable(orgId);
    return {
      modelProvider: ready ? "ready" : fixable.length > 0 ? "org_fixable" : "none",
      orgFixableProviders: fixable,
      agents: visible.length,
    };
  }

  private async orgFixable(orgId: string): Promise<OrgFixableProvider[]> {
    const out: OrgFixableProvider[] = [];
    for (const v of await this.configs.list(orgId)) {
      if (!isModelProvider(v)) continue;
      const reason = fixOf(v);
      if (reason !== null) out.push({ provider: v.plugin, reason });
    }
    return out;
  }
}
