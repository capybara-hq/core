import type { ModelParameter } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { ExtensionHost } from "../extensions/host.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ModelPurposesService } from "../models/purposes.js";
import { can } from "../orgs/roles.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { AgentsService, type AgentView, type AgentVisibility } from "./agents.service.js";
import type { ModelRef } from "./definition.js";
import {
  type ModelSource,
  type PlanItem,
  type PlanOptions,
  planFromTemplate,
  type TemplatePlan,
} from "./from-template.js";
import { PendingConnectorRequests } from "./pending-connector-requests.js";
import type { ProfileInput } from "./profile.js";
import { loadTemplates, type TemplateRow } from "./templates.js";

/** The preview of creating an agent from a template (`POST …/agents/from-template/preview`). */
export interface TemplatePreview {
  items: PlanItem[];
  /** The model the dialog preselects (P4-4); null when the org has no usable model. */
  model: (ModelRef & { source: ModelSource }) | null;
  dropped: string[];
  previewHash: string;
}

export interface CreateFromTemplateRequest {
  templateId: string;
  name: string;
  visibility?: AgentVisibility;
  members?: string[];
  model?: ModelRef;
  avatar?: ProfileInput["avatar"];
  previewHash: string;
}

/**
 * Creating agents from templates (rulings P4-3…P4-8): the preview and the create both resolve the
 * template with {@link planFromTemplate}; the create refuses a plan whose hash differs from the
 * preview's (409 `agent.template_preview_stale`), writes the agent through
 * {@link AgentsService.createFromTemplate}, and after the commit opens the pending connector request
 * when the creator cannot configure connectors.
 */
@Injectable()
export class AgentsFromTemplate {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(AgentsService) private readonly agents: AgentsService,
    /** Extension tools loaded here and the org's enabled extensions. */
    @Inject(ExtensionHost) private readonly host: Pick<ExtensionHost, "tools" | "enabledPlugins">,
    @Inject(ProviderRegistry)
    private readonly providers: Pick<ProviderRegistry, "resolve" | "list">,
    /** The tier's purpose mapping (`subagent_<tier>`, P4-4). */
    @Inject(ModelPurposesService) private readonly purposes: Pick<ModelPurposesService, "resolve">,
    @Inject(PendingConnectorRequests) private readonly requests: PendingConnectorRequests,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /** The template, when usable in the org (P4-3); otherwise 404 `agent.template_not_found`. */
  private async template(orgId: string, templateId: string): Promise<TemplateRow> {
    const row = (await loadTemplates(this.db.db, orgId, [templateId])).get(templateId);
    if (!row) {
      throw new ApiError(
        "agent.template_not_found",
        "The agent template does not exist or is not available in this organization",
      );
    }
    return row;
  }

  private async plan(orgId: string, row: TemplateRow, model?: ModelRef): Promise<TemplatePlan> {
    const opts: PlanOptions = {
      pluginTools: this.host.tools().map((t) => ({ plugin: t.plugin, name: t.spec.name })),
      enabledPlugins: await this.host.enabledPlugins(orgId),
      resolveModel: async (ref): Promise<ModelParameter[] | null> => {
        try {
          return (await this.providers.resolve(ref)).info.parameters;
        } catch {
          return null;
        }
      },
      purpose: async (purpose) => {
        try {
          return await this.purposes.resolve(orgId, purpose);
        } catch (e) {
          if (e instanceof ApiError) return null;
          throw e;
        }
      },
      defaultModel: async () => {
        for (const p of await this.providers.list()) {
          const m = p.models[0];
          if (m) return { provider: p.provider, model: m.id };
        }
        return null;
      },
      ...(model !== undefined && { model }),
    };
    return planFromTemplate(this.db.db, orgId, row, opts);
  }

  async preview(orgId: string, templateId: string): Promise<TemplatePreview> {
    const plan = await this.plan(orgId, await this.template(orgId, templateId));
    return {
      items: plan.items,
      model: plan.model === null ? null : { ...plan.model.ref, source: plan.model.source },
      dropped: plan.dropped,
      previewHash: plan.hash,
    };
  }

  async create(
    orgId: string,
    actorAccountId: string,
    req: CreateFromTemplateRequest,
    actorTokenId?: string,
  ): Promise<{ agent: AgentView }> {
    const row = await this.template(orgId, req.templateId);
    const plan = await this.plan(orgId, row, req.model);
    if (plan.hash !== req.previewHash) {
      throw new ApiError(
        "agent.template_preview_stale",
        "The template or the organization changed since the preview; preview it again",
      );
    }
    if (plan.model === null) {
      throw new ApiError("agent.model_unavailable", "No model is available for the new agent");
    }
    const { agent, role } = await this.agents.createFromTemplate(
      orgId,
      actorAccountId,
      {
        definition: {
          ...plan.definition,
          name: req.name,
          model: plan.model.ref,
          modelParams: plan.model.params,
        },
        visibility: req.visibility ?? "private",
        ...(req.members !== undefined && { memberIds: req.members }),
        profile: {
          description: plan.profile.description,
          quickActions: plan.profile.quickActions,
          ...(req.avatar != null && { avatar: req.avatar }),
        },
      },
      { id: req.templateId, version: row.version, name: row.name },
      actorTokenId,
    );
    const keys = (agent.definition.pendingConnectors ?? []).map((c) => c.key);
    if (keys.length > 0 && !can(role, "connectors.manage")) {
      try {
        await this.requests.openFor({
          orgId,
          agentId: agent.id,
          ownerAccountId: agent.ownerAccountId,
          keys,
        });
      } catch (err) {
        // the agent stands; its 待配置 notice offers the request again (ruling P4-7)
        this.log.warn("cannot open the pending connector request of a new agent", {
          orgId,
          agentId: agent.id,
          err,
        });
      }
    }
    return { agent };
  }
}
