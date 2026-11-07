import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ExtensionDisplayNames } from "../../extensions/display-name.js";
import { ExtensionRegistry } from "../../extensions/registry.js";
import { ModelDisabledPatch, ModelProviderParams } from "../../models/enablement.controller.js";
import { ModelEnablement } from "../../models/enablement.js";
import { ModelPurposePathParams } from "../../models/org-models.schemas.js";
import { ModelPurposesService, withDeclaredByNames } from "../../models/purposes.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { named } from "./summary.js";

const Purpose = ModelPurposePathParams.shape.purpose.max(100);
const Provider = ModelProviderParams.shape.provider;
const ModelIds = ModelDisabledPatch.shape.disable.unwrap().max(500);

/** A purpose's target as the operation takes it: the route's, with every string bounded. */
const Target = z
  .object({
    model: z
      .object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200) })
      .strict(),
    params: z
      .record(z.string().min(1).max(100), z.union([z.string().max(1000), z.number(), z.boolean()]))
      .optional(),
  })
  .strict()
  .nullable();

/** Up to ten model ids for a card, the rest as "…". */
const few = (ids: readonly string[], sep: string): string =>
  ids.slice(0, 10).map(named).join(sep) + (ids.length > 10 ? `${sep}…` : "");

/** `provider/model`, as a card names a model. */
const ref = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;

/**
 * The org's model operations of the `Platform` tool (spec §14.2): the model per purpose (the
 * platform default, the org's override, the effective one) and setting or clearing the override,
 * and the org's switched-off models of one provider. Org admins (`org.models.manage`). The
 * platform's defaults and model list are the admin console's (platform-admin operations).
 */
@Injectable()
export class ModelsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ModelPurposesService) private readonly purposes: ModelPurposesService,
    @Inject(ModelEnablement) private readonly enablement: ModelEnablement,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(ExtensionRegistry) private readonly extensions: ExtensionRegistry,
  ) {}

  /** The precheck refusal of a provider that is not a running model-provider extension. */
  private providerPrecheck(provider: string): PrecheckResult {
    return this.extensions.list("model-provider").some((e) => e.plugin === provider)
      ? { ok: true }
      : {
          ok: false,
          code: "model.provider_not_found",
          message: `Model provider ${provider} is not installed`,
        };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "models.purposes",
        description:
          "List the model purposes of this org (org admins): each purpose (such as chat, title, compaction, embedding) with its label, the platform default, the org's override and the effective model.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "org.models.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/model-purposes"],
        confirm: "read",
        run: async (_input, ctx) => ({
          purposes: await withDeclaredByNames(
            await this.purposes.list(ctx.orgId),
            this.displayNames,
          ),
        }),
      }),
      defineOperation({
        id: "models.set-purpose",
        description:
          "Set the org's model for one purpose (org admins): target.model is { provider, model } with optional params, or target null to clear the override and fall back to the platform default. The model must be usable in the org and of the purpose's kind.",
        input: z.object({ purpose: Purpose, target: Target }).strict(),
        example: {
          purpose: "title",
          target: { model: { provider: "model-anthropic", model: "claude-haiku-4-5" } },
        },
        authz: { orgAction: "org.models.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/model-purposes/:purpose"],
        confirm: "org",
        errors: [
          { code: "model.purpose_unknown", next: "Check the purpose with models.purposes." },
          {
            code: "agent.model_unavailable",
            next: "The model is not usable in this org (off, not listed, or its provider needs config); pick another one.",
          },
          {
            code: "validation_failed",
            next: "The model is of another kind than the purpose, or a param is invalid; fix it as the message says.",
          },
        ],
        precheck: async (i, ctx) => {
          let known = false;
          const r = await precheckBy(async () => {
            known = (await this.purposes.list(ctx.orgId)).some((p) => p.purpose === i.purpose);
          });
          if (!r.ok) return r;
          if (!known) {
            return {
              ok: false,
              code: "model.purpose_unknown",
              message: `Model purpose ${i.purpose} is not declared`,
            };
          }
          return i.target === null ? { ok: true } : this.providerPrecheck(i.target.model.provider);
        },
        summary: async (i, ctx) => {
          const p = (await this.purposes.list(ctx.orgId)).find((x) => x.purpose === i.purpose);
          const label = p?.label ?? { zh: i.purpose, en: i.purpose };
          return i.target === null
            ? {
                zh: `清除本组织「${label.zh}」用途的模型覆盖（改用平台默认）`,
                en: `Clear the org's model for purpose "${label.en}" (use the platform default)`,
              }
            : {
                zh: `把本组织「${label.zh}」用途的模型设为 ${ref(i.target.model)}`,
                en: `Set the org's model for purpose "${label.en}" to ${ref(i.target.model)}`,
              };
        },
        run: async (input, ctx) => {
          const view = await this.purposes.setOrg(
            ctx.orgId,
            input.purpose,
            input.target === null
              ? null
              : { model: input.target.model, params: input.target.params ?? {} },
            ctx.actorAccountId,
            undefined,
            viaAgent("models.set-purpose", ctx),
          );
          const [listing] = await withDeclaredByNames([view], this.displayNames);
          return { purpose: listing };
        },
      }),
      defineOperation({
        id: "models.set-disabled",
        description:
          "Switch models of one provider off or back on in this org (org admins): disable and enable list model ids; ids in neither keep their state. Returns the org's agents and purposes that now point at a newly switched-off model (the change is not refused for them).",
        input: z
          .object({
            provider: Provider,
            disable: ModelIds.default([]),
            enable: ModelIds.default([]),
          })
          .strict()
          .refine((v) => !v.enable.some((m) => v.disable.includes(m)), {
            message: "A model cannot be both disabled and enabled",
            path: ["enable"],
          }),
        example: { provider: "model-anthropic", disable: ["claude-opus-4-1"], enable: [] },
        authz: { orgAction: "org.models.manage" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/models/:provider/disabled"],
        confirm: "org",
        errors: [
          {
            code: "model.provider_not_found",
            next: "Check the provider (the model-provider extension's name) with models.purposes or extensions.list.",
          },
        ],
        precheck: async (i) => this.providerPrecheck(i.provider),
        summary: (i) => ({
          zh: `在本组织调整提供者 ${i.provider} 的模型：停用 ${i.disable.length} 个（${few(i.disable, "、") || "无"}），恢复 ${i.enable.length} 个（${few(i.enable, "、") || "无"}）`,
          en: `Change models of provider ${i.provider} in the org: switch off ${i.disable.length} (${few(i.disable, ", ") || "none"}), back on ${i.enable.length} (${few(i.enable, ", ") || "none"})`,
        }),
        run: async (input, ctx) =>
          this.enablement.setOrg(
            ctx.orgId,
            input.provider,
            { disable: input.disable, enable: input.enable },
            { accountId: ctx.actorAccountId, auditDetail: viaAgent("models.set-disabled", ctx) },
          ),
      }),
    ]);
  }
}
