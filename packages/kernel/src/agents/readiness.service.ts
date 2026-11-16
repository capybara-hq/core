import { MODEL_PROVIDER_EXTENSION_POINT_V2, parseExtensionPoint } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import {
  OrgExtensionConfigs,
  type OrgExtensionView,
  providesOf,
} from "../extensions/org-config.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { AgentsService } from "./agents.service.js";

/** What `GET /orgs/:orgId/readiness` and the `agents.readiness` operation answer. */
export interface OrgReadiness {
  /** `ready` when a model provider is usable in the org (extension state only, no vendor call). */
  modelProvider: "ready" | "none";
  /**
   * Whether an org admin can make a model provider usable from the org's 扩展 page: a provider
   * loaded on the deployment that is off in this org (and the org may switch it), or on but
   * waiting for the org's own config. False when only the super admin can help (no provider is
   * loaded on the deployment). Meaningful while `modelProvider` is `none`.
   */
  orgCanAddModel: boolean;
  /** The agents the caller can see (the agent list's visibility). */
  agents: number;
}

const MODEL_PROVIDER = parseExtensionPoint(MODEL_PROVIDER_EXTENSION_POINT_V2).name;

const isModelProvider = (v: OrgExtensionView) =>
  providesOf(v).some((ref) => parseExtensionPoint(ref).name === MODEL_PROVIDER);

/**
 * Whether the org admin can turn `v` into a usable provider here: it is loaded on the deployment
 * and either switchable while off, or on and waiting for the org's config (an org-level field or
 * an overridable platform field).
 */
const orgCanFix = (v: OrgExtensionView) =>
  v.available &&
  ((!v.enabled && v.switchable) ||
    (v.enabled && v.needsConfig && (v.configurable || v.overrideState !== "none")));

/**
 * Whether the org can run (web-order spec §3.8): the web app decides between the shell and the
 * setup layout with it, and the setup checklist sends the viewer to the org's 扩展 page or to the
 * admin console by `orgCanAddModel`.
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
    return {
      modelProvider: ready ? "ready" : "none",
      orgCanAddModel: ready ? false : await this.orgCanAddModel(orgId),
      agents: visible.length,
    };
  }

  private async orgCanAddModel(orgId: string): Promise<boolean> {
    const views = await this.configs.list(orgId);
    return views.some((v) => isModelProvider(v) && orgCanFix(v));
  }
}
