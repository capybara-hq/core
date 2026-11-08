import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { DeploymentSettingsBody, PurposeParams } from "../../admin/admin.schemas.js";
import { CatalogRequestsService } from "../../catalog/requests.service.js";
import { ApiError } from "../../errors.js";
import { ExtensionAdmin } from "../../extensions/admin-view.js";
import { ExtensionDisplayNames } from "../../extensions/display-name.js";
import { extensionNeedsAction } from "../../extensions/permission-view.js";
import { ExtensionRegistry } from "../../extensions/registry.js";
import { AccountsService } from "../../identity/accounts.js";
import { DEPLOYMENT_SETTINGS_PATCH, SettingsService } from "../../identity/settings.js";
import { ModelDisabledPatch, ModelProviderParams } from "../../models/enablement.controller.js";
import { ModelEnablement } from "../../models/enablement.js";
import { MODEL_PRICE_PUT, PricesService } from "../../models/prices.js";
import { purposeTargetOf } from "../../models/purposes.controller.js";
import { ModelPurposesService, PURPOSE_PUT, withDeclaredByNames } from "../../models/purposes.js";
import { OrgsService } from "../../orgs/orgs.service.js";
import { ProviderRegistry } from "../../runtime/providers.js";
import { ThemesService } from "../../themes/themes.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { localized, named } from "./summary.js";

const PAGE = 50;

/** The deployment-wide settings `admin.update-settings` changes (the per-org limits are orgs.set-limits). */
const SettingsInput = DEPLOYMENT_SETTINGS_PATCH.pick({
  orgCreation: true,
  priceCurrency: true,
  customConnectors: true,
  customSkills: true,
  orgMarketplaceBrowse: true,
  uiTheme: true,
}).strict();

const ProviderId = ModelProviderParams.shape.provider.describe(
  "The model provider (models.platform-list), e.g. the plugin name of its extension.",
);

/** `provider/model` of a purpose target, or null. */
const refOf = (t: { model: { provider: string; model: string } } | null) =>
  t === null ? null : `${t.model.provider}/${t.model.model}`;

/**
 * Admin console operations of the `Platform` tool (spec §14.2): the dashboard totals, the
 * deployment settings, and the platform's models (the model catalog with the platform's disabled
 * list, the price table, the default model per purpose). Super admin only, through their own
 * private agent. The per-org overrides of models and purposes are the org's own pages.
 */
@Injectable()
export class AdminOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ExtensionAdmin) private readonly extensions: ExtensionAdmin,
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CatalogRequestsService) private readonly catalogRequests: CatalogRequestsService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(ExtensionRegistry) private readonly extensionRegistry: ExtensionRegistry,
    @Inject(ModelEnablement) private readonly enablement: ModelEnablement,
    @Inject(PricesService) private readonly prices: PricesService,
    @Inject(ModelPurposesService) private readonly purposes: ModelPurposesService,
    @Inject(ThemesService) private readonly themes: ThemesService,
  ) {}

  private assertProvider(provider: string): void {
    if (!this.extensionRegistry.list("model-provider").some((e) => e.plugin === provider)) {
      throw new ApiError("model.provider_not_found", `Model provider ${provider} is not installed`);
    }
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "admin.overview",
        description:
          "The admin console's dashboard totals (super admin): extensions that need the super admin's action, catalog requests waiting for deployment, and the numbers of orgs and accounts.",
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/overview"],
        confirm: "read",
        run: async () => {
          const [plugins, orgs, accounts, catalogRequestsPending] = await Promise.all([
            this.extensions.list(),
            this.orgs.listAll(),
            this.accounts.count(),
            this.catalogRequests.countPendingDeployment(),
          ]);
          return {
            extensionsNeedingAction: plugins.filter((p) => extensionNeedsAction(p.status)).length,
            catalogRequestsPending,
            orgs: orgs.length,
            accounts,
          };
        },
      }),
      defineOperation({
        id: "admin.settings",
        description:
          "Read the deployment settings (super admin): who may create orgs (orgCreation), the price currency, whether orgs may create their own connectors and skills, whether org admins may browse the marketplaces, and the per-org limit overrides keyed by org id (orgs.get reads one org's).",
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/settings"],
        confirm: "read",
        run: () => this.settings.get(),
      }),
      defineOperation({
        id: "admin.update-settings",
        description:
          "Change deployment settings (super admin); give only the keys to change: orgCreation (anyone or super_admin), priceCurrency (ISO 4217 code), customConnectors / customSkills (allow or deny: whether orgs may create their own instead of installing from the catalog), orgMarketplaceBrowse (true or false), uiTheme ({ id }: the platform default theme, a platform theme whose scope is all, or null for the built-in theme; it is what every org falls back to and what the sign-in pages show). Per-org limits are orgs.set-limits.",
        input: SettingsInput.refine((b) => Object.keys(b).length > 0, {
          message: "at least one setting is required",
        }),
        example: { orgCreation: "super_admin" },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/settings"],
        // the per-org override records are orgs.set-limits (one org at a time)
        omits: ["runConcurrencyOverrides", "sandboxLimitOverrides", "subagentLimitOverrides"],
        confirm: "platform",
        errors: [
          {
            code: "validation_failed",
            next: "Fix the values as the message says (admin.settings shows the current ones).",
          },
          {
            code: "theme.not_available",
            next: "Choose a platform theme whose scope is all and that is not disabled (plugins.components with kind theme lists them), or { id: null } for the built-in theme.",
          },
        ],
        precheck: async (i) => {
          const r = DeploymentSettingsBody.safeParse(i);
          return r.success
            ? { ok: true }
            : { ok: false, code: "validation_failed", message: r.error.issues[0]?.message ?? "" };
        },
        summary: async (i) => {
          const { uiTheme, ...rest } = i;
          const parts = Object.entries(rest).map(([k, v]) => `${k}=${String(v)}`);
          const zh = [...parts];
          const en = [...parts];
          if (uiTheme !== undefined) {
            // the theme by its name (the super admin sees every theme), the built-in one by name
            const name = uiTheme.id === null ? null : await this.themes.nameOf(uiTheme.id);
            zh.push(`uiTheme=${uiTheme.id === null ? "内置主题" : (name?.zh ?? uiTheme.id)}`);
            en.push(`uiTheme=${uiTheme.id === null ? "built-in theme" : (name?.en ?? uiTheme.id)}`);
          }
          return {
            zh: `修改平台部署设置：${zh.join("，")}`,
            en: `Change the deployment settings: ${en.join(", ")}`,
          };
        },
        run: (input, ctx) =>
          this.settings.update(
            input,
            ctx.actorAccountId,
            undefined,
            viaAgent("admin.update-settings", ctx),
          ),
      }),
      defineOperation({
        id: "models.platform-list",
        description:
          "The platform's model catalog (super admin). Without provider: one row per model provider with its state (ok, error with the reason, org_configured: each org configures it), its plugin and how many models it lists and how many the platform disabled. With provider: that provider's models, one row each (id, name, kind, disabled), paged by 50 (pass the returned next as params.cursor).",
        input: z.object({ provider: ProviderId.optional(), cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/models"],
        extras: ["provider", "cursor"],
        confirm: "read",
        errors: [
          {
            code: "model.provider_not_found",
            next: "Pick a provider from models.platform-list.",
          },
        ],
        run: async (input) => {
          const providers = await this.providers.listWithStatus();
          if (input.provider === undefined) {
            const names = await this.displayNames.many(providers.map((p) => p.plugin));
            return {
              items: providers.map((p) => ({
                id: p.provider,
                name: localized(names.get(p.plugin), p.plugin).en,
                state: p.status,
                ...(p.error !== undefined && { reason: p.error }),
                plugin: p.plugin,
                models: p.models.length,
                disabled: p.models.filter((m) => m.disabled === true).length,
              })),
            };
          }
          const p = providers.find((x) => x.provider === input.provider);
          if (!p) {
            throw new ApiError(
              "model.provider_not_found",
              `Model provider ${input.provider} is not installed`,
            );
          }
          return pageOf(
            p.models.map((m) => ({
              id: m.id,
              name: m.displayName ?? m.id,
              kind: m.kind,
              disabled: m.disabled === true,
            })),
            startOf(input.cursor),
            PAGE,
          );
        },
      }),
      defineOperation({
        id: "models.set-platform-disabled",
        description:
          "Disable or enable models of one provider for the whole platform (super admin): disable and enable list model ids (models.platform-list with provider); ids in neither keep their state. A disabled model is invisible to every org. The result lists the agents and purposes, across orgs, that point at a newly disabled model (the disable is not refused for them).",
        input: z
          .object({
            provider: ProviderId,
            disable: ModelDisabledPatch.shape.disable,
            enable: ModelDisabledPatch.shape.enable,
          })
          .strict()
          .refine((i) => i.disable.length > 0 || i.enable.length > 0, {
            message: "give disable or enable",
          }),
        example: { provider: "model-fake", disable: ["fake-1"], enable: [] },
        authz: { superAdmin: true },
        mirrors: ["PATCH /api/v1/admin/models/:provider/disabled"],
        confirm: "platform",
        errors: [
          {
            code: "model.provider_not_found",
            next: "Pick a provider from models.platform-list.",
          },
          {
            code: "validation_failed",
            next: "Fix the lists as the message says (an id in both is refused).",
          },
        ],
        precheck: async (i) => {
          const r = await precheckBy(async () => this.assertProvider(i.provider));
          if (!r.ok) return r;
          const disable = new Set(i.disable);
          const both = i.enable.filter((m) => disable.has(m));
          return both.length === 0
            ? { ok: true }
            : {
                ok: false,
                code: "validation_failed",
                message: `Both disabled and enabled: ${both.slice(0, 5).join(", ")}`,
              };
        },
        summary: (i) => {
          const list = (ids: string[]) =>
            ids.slice(0, 5).map(named).join(", ") + (ids.length > 5 ? ` (+${ids.length - 5})` : "");
          const zh = [
            i.disable.length > 0 && `停用 ${list(i.disable)}`,
            i.enable.length > 0 && `启用 ${list(i.enable)}`,
          ].filter((p): p is string => typeof p === "string");
          const en = [
            i.disable.length > 0 && `disable ${list(i.disable)}`,
            i.enable.length > 0 && `enable ${list(i.enable)}`,
          ].filter((p): p is string => typeof p === "string");
          return {
            zh: `在全平台${zh.join("，")}（供应商 ${named(i.provider)}）`,
            en: `Platform-wide, ${en.join(" and ")} (provider ${named(i.provider)})`,
          };
        },
        run: (input, ctx) =>
          this.enablement.setPlatform(
            input.provider,
            { disable: input.disable, enable: input.enable },
            {
              accountId: ctx.actorAccountId,
              auditDetail: viaAgent("models.set-platform-disabled", ctx),
            },
          ),
      }),
      defineOperation({
        id: "models.prices",
        description:
          "The model price table (super admin): price per million tokens for input, output, cache read and cache write, by provider and model, in the deployment's currency. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/model-prices"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input) => {
          const [prices, s] = await Promise.all([this.prices.list(), this.settings.get()]);
          return { currency: s.priceCurrency, ...pageOf(prices, startOf(input.cursor), PAGE) };
        },
      }),
      defineOperation({
        id: "models.set-price",
        description:
          "Set the price of one model per million tokens (super admin): provider, model, inputPerMTok, outputPerMTok, cacheReadPerMTok and cacheWritePerMTok (null when the model has none); or provider, model and price: null to remove its price. Prices only estimate costs in the deployment's currency.",
        input: MODEL_PRICE_PUT,
        example: {
          provider: "model-fake",
          model: "fake-1",
          inputPerMTok: 3,
          outputPerMTok: 15,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/model-prices"],
        confirm: "platform",
        errors: [{ code: "validation_failed", next: "Fix the prices as the message says." }],
        summary: (i) => {
          const m = `${named(i.provider)}/${named(i.model)}`;
          return "price" in i
            ? { zh: `删除模型 ${m} 的价格`, en: `Remove the price of model ${m}` }
            : {
                zh: `设置模型 ${m} 的价格（每百万 token）：输入 ${i.inputPerMTok}，输出 ${i.outputPerMTok}`,
                en: `Set the price of model ${m} per million tokens: input ${i.inputPerMTok}, output ${i.outputPerMTok}`,
              };
        },
        run: async (input, ctx) => {
          await this.prices.put(
            input,
            ctx.actorAccountId,
            undefined,
            viaAgent("models.set-price", ctx),
          );
          const [prices, s] = await Promise.all([this.prices.list(), this.settings.get()]);
          const price = prices.find(
            (p) => p.provider === input.provider && p.model === input.model,
          );
          return { price: price ?? null, currency: s.priceCurrency };
        },
      }),
      defineOperation({
        id: "models.platform-purposes",
        description:
          "The model purposes (super admin): what the kernel and extensions use a model for (title generation, summaries, embeddings, …), one row each with its kind (chat or embedding), who declares it, and the platform's default model (provider/model, null when none). Orgs may override a purpose on their own page.",
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/model-purposes"],
        confirm: "read",
        run: async () => {
          const list = await withDeclaredByNames(await this.purposes.list(), this.displayNames);
          return {
            items: list.map((p) => ({
              id: p.purpose,
              name: p.label.en,
              state: p.default === null ? "unconfigured" : "configured",
              kind: p.kind,
              declaredBy: p.declaredBy,
              default: refOf(p.default),
            })),
          };
        },
      }),
      defineOperation({
        id: "models.set-platform-purpose",
        description:
          "Set the platform's default model of a purpose (super admin), or clear it with target: null. target is {model: {provider, model}, params?}; the model must be a platform model of the purpose's kind (models.platform-purposes, models.platform-list) and params must fit its declared parameters.",
        input: z
          .object({ purpose: PurposeParams.shape.purpose, target: PURPOSE_PUT.shape.target })
          .strict(),
        example: {
          purpose: "title",
          target: { model: { provider: "model-fake", model: "fake-1" } },
        },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/model-purposes/:purpose"],
        confirm: "platform",
        errors: [
          {
            code: "model.purpose_unknown",
            next: "Pick a purpose from models.platform-purposes.",
          },
          {
            code: "validation_failed",
            next: "Pick a model of the purpose's kind from models.platform-list, with params it declares.",
          },
        ],
        precheck: (i) =>
          precheckBy(() =>
            this.purposes.validate(null, i.purpose, purposeTargetOf({ target: i.target })),
          ),
        summary: (i) => {
          const target = refOf(i.target);
          return target === null
            ? {
                zh: `清除用途「${named(i.purpose)}」的平台默认模型`,
                en: `Clear the platform default model of purpose "${named(i.purpose)}"`,
              }
            : {
                zh: `把用途「${named(i.purpose)}」的平台默认模型设为 ${named(target)}`,
                en: `Set the platform default model of purpose "${named(i.purpose)}" to ${named(target)}`,
              };
        },
        run: async (input, ctx) => {
          const view = await this.purposes.setDefault(
            input.purpose,
            purposeTargetOf({ target: input.target }),
            ctx.actorAccountId,
            undefined,
            viaAgent("models.set-platform-purpose", ctx),
          );
          return {
            purpose: {
              id: view.purpose,
              kind: view.kind,
              default: refOf(view.default),
              params: view.default?.params ?? null,
            },
          };
        },
      }),
    ]);
  }
}
