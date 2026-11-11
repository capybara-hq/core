import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { DeploymentSettingsBody, PurposeParams } from "../../admin/admin.schemas.js";
import { AuditListQuery } from "../../admin/audit.schemas.js";
import { AdminHealthService } from "../../admin/health.service.js";
import { UsageQuery } from "../../admin/overview.schemas.js";
import { type AdminAttention, AdminOverviewService } from "../../admin/overview.service.js";
import { PlatformAuditService } from "../../admin/platform-audit.service.js";
import { AdminUsageService } from "../../admin/usage.service.js";
import { ApiError } from "../../errors.js";
import { ExtensionDisplayNames } from "../../extensions/display-name.js";
import { ExtensionRegistry } from "../../extensions/registry.js";
import { DEPLOYMENT_SETTINGS_PATCH, SettingsService } from "../../identity/settings.js";
import { ModelDisabledPatch, ModelProviderParams } from "../../models/enablement.controller.js";
import { ModelEnablement } from "../../models/enablement.js";
import { MODEL_PRICE_PUT, PricesService } from "../../models/prices.js";
import { purposeTargetOf } from "../../models/purposes.controller.js";
import { ModelPurposesService, PURPOSE_PUT, withDeclaredByNames } from "../../models/purposes.js";
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
  uiArrangement: true,
  clientExtensions: true,
}).strict();

const ProviderId = ModelProviderParams.shape.provider.describe(
  "The model provider (models.platform-list), e.g. the plugin name of its extension.",
);

/** `provider/model` of a purpose target, or null. */
const refOf = (t: { model: { provider: string; model: string } } | null) =>
  t === null ? null : `${t.model.provider}/${t.model.model}`;

/** The attention lists as compact rows (`next`: the admin console page that fixes it). */
function attentionRows(a: AdminAttention) {
  return {
    items: [
      ...a.extensions.map((e) => ({
        kind: "extension" as const,
        id: e.name,
        name: localized(e.displayName, e.name).en,
        state: e.status,
        reason: e.reason,
        next: `Fix it on the extension's page in the admin console (/admin/extensions/${e.name}).`,
      })),
      ...a.updates.map((u) => ({
        kind: "update" as const,
        id: u.itemId,
        name: localized(u.displayName, u.name).en,
        state: "newer_in_marketplace",
        reason: `${u.version} -> ${u.marketplaceVersion}`,
        next: `Upgrade it on the plugin's page in the admin console (/admin/plugins/${u.itemId}); a newer version is never imported automatically.`,
      })),
      ...a.providers.map((p) => ({
        kind: "provider" as const,
        id: p.plugin,
        name: localized(p.displayName, p.plugin).en,
        state: p.problem === "list_failed" ? "error" : "ok",
        reason: p.problem,
        next:
          p.problem === "list_failed"
            ? `Check the provider's deployment config and connection on its extension page (/admin/extensions/${p.plugin}); the models page (/admin/models) shows the list.`
            : "The provider lists no chat model that is switched on: switch one on in the admin console (/admin/models) or check the provider's config.",
      })),
    ],
    more: a.more,
    unavailable: a.unavailable,
  };
}

/**
 * Admin console operations of the `Platform` tool (spec §14.2): the dashboard numbers and attention lists, the platform audit log, the
 * deployment settings, and the platform's models (the model catalog with the platform's disabled
 * list, the price table, the default model per purpose). Super admin only, through their own
 * private agent. The per-org overrides of models and purposes are the org's own pages.
 */
@Injectable()
export class AdminOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(ExtensionRegistry) private readonly extensionRegistry: ExtensionRegistry,
    @Inject(ModelEnablement) private readonly enablement: ModelEnablement,
    @Inject(PricesService) private readonly prices: PricesService,
    @Inject(ModelPurposesService) private readonly purposes: ModelPurposesService,
    @Inject(ThemesService) private readonly themes: ThemesService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AdminOverviewService) private readonly overview: AdminOverviewService,
    @Inject(AdminHealthService) private readonly health: AdminHealthService,
    @Inject(AdminUsageService) private readonly usage: AdminUsageService,
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
          "The admin console's dashboard numbers (super admin): orgs, accounts and attentionTotal, everything waiting for a super admin (the platform inbox total plus the extensions, plugin updates and model providers admin.attention lists); partial is true when one of those lists could not be read right now (attentionTotal then leaves it out).",
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/overview"],
        confirm: "read",
        run: () => this.overview.stats(),
      }),
      defineOperation({
        id: "admin.attention",
        description:
          "What needs the super admin besides the platform inbox (super admin), one compact row each (kind, id, name, state, reason, next step): extensions (reason config, load_failed, approval, dependency, conflict, converging or legacy_format), platform plugins with a newer marketplace version (reason names both versions) and model providers (reason list_failed or no_chat_model). Each kind lists at most 20 rows; more counts the rest per kind. unavailable names a kind that could not be read right now (try again later). The platform inbox itself is inbox.platform-list.",
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/overview/attention"],
        confirm: "read",
        run: async () => attentionRows(await this.overview.attention()),
      }),
      defineOperation({
        id: "admin.health",
        description:
          'How the platform runs right now (super admin), to answer "is the worker up, is the run queue backing up": kernel.version; replicas (live kernel processes: id, roles, version, startedAt) and roles (live replicas per role: api serves requests, worker runs conversations and jobs, gateway holds channel and device connections; 0 workers means no run starts); queues (per kernel queue, e.g. cap-kernel-runs: waiting, active, delayed, failed and failedLastDay, counts only); channels (online, offline: active long connections no replica holds, webhook, disabled, error); devices (online / local); sandboxes (running, suspended, running per provider). unavailable names a source that did not answer (redis or database); its numbers are then null. Failure details are in the kernel logs, not here.',
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/overview/health"],
        confirm: "read",
        run: () => this.health.read(),
      }),
      defineOperation({
        id: "admin.usage",
        description:
          "What the platform used over the last 7 days (super admin): today and the 6 days before, as calendar days in tz (an IANA zone such as Asia/Shanghai; use the person's own zone). days has one entry per day, oldest first: runs (every run, sub-agent and eval replay runs included), tokens (input, output, cacheRead, cacheWrite of every model call, and embedding) and cost. cost is an estimate from the model prices the super admin entered (models.prices), in currency; it is null when tokens were used and none of them had a price, and costPartial is true when some tokens had no price (the costs then count only the priced ones). orgs lists the 10 orgs that used the most tokens (runs, tokens, cost each); otherOrgs sums the rest (count, runs, tokens, cost). Totals only: never per account, agent or conversation. The answer may be up to 5 minutes old. admin.usage_unavailable means the database took too long: try again later.",
        input: UsageQuery.strict(),
        example: { tz: "Asia/Shanghai" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/overview/usage"],
        confirm: "read",
        errors: [
          {
            code: "admin.usage_unavailable",
            next: "The usage numbers took too long to compute; try again in a few minutes.",
          },
        ],
        run: (input) => this.usage.week(input.tz),
      }),
      defineOperation({
        id: "admin.audit",
        description:
          "The platform-level audit log (super admin), newest first: deployment settings, accounts, marketplaces, catalog imports and scope, extensions, model prices and purposes, setup. Each event has its id, time, actor (id, name, email; null for the kernel itself), viaToken (done with a personal access token), viaAgent (done through the Platform tool), action and target; never the event's details, and never an org's own events. limit is 1 to 100 (default 20); pages by keyset: pass the returned next as params.after (null: no more).",
        input: AuditListQuery.strict(),
        example: { limit: 20 },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/audit"],
        confirm: "read",
        run: (input) => this.audit.list(input),
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
          "Change deployment settings (super admin); give only the keys to change: orgCreation (anyone or super_admin), priceCurrency (ISO 4217 code), customConnectors / customSkills (allow or deny: whether orgs may create their own instead of installing from the catalog), orgMarketplaceBrowse (true or false), uiTheme ({ id }: the platform default theme, a platform theme whose scope is all, or null for the built-in theme; it is what every org falls back to and what the sign-in pages show), uiArrangement ({ <slot>: { hidden, order } } for a list slot, { <slot>: { use } } for a single slot: the platform default arrangement of UI slots, with contribution keys <extension>/<contribution>; hidden ones are not listed but still open by URL; use names the contribution that replaces the built-in, null for the built-in; null for a slot removes its entry), clientExtensions ({ enabled?, disabled? }: the kill switch of plugin client code; enabled false stops every plugin's interface code in every browser, disabled is the whole list of plugins whose interface code alone is stopped while their tools keep working; read the current list from admin.settings first). Per-org limits are orgs.set-limits.",
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
            next: "The platform default must be a platform theme whose scope is all, not disabled, and on in every organization. When the details list orgs, the theme is off in those organizations: tell the person their names, then choose another theme (plugins.components with kind theme lists them) or have it switched on in those organizations first; { id: null } sets the built-in theme.",
          },
        ],
        precheck: async (i) => {
          const r = DeploymentSettingsBody.safeParse(i);
          return r.success
            ? { ok: true }
            : { ok: false, code: "validation_failed", message: r.error.issues[0]?.message ?? "" };
        },
        summary: async (i) => {
          const { uiTheme, uiArrangement, clientExtensions, ...rest } = i;
          const parts = Object.entries(rest).map(([k, v]) => `${k}=${String(v)}`);
          const zh = [...parts];
          const en = [...parts];
          if (uiTheme !== undefined) {
            // the theme by its name (the super admin sees every theme), the built-in one by name
            const name = uiTheme.id === null ? null : await this.themes.nameOf(uiTheme.id);
            zh.push(`uiTheme=${uiTheme.id === null ? "内置主题" : (name?.zh ?? uiTheme.id)}`);
            en.push(`uiTheme=${uiTheme.id === null ? "built-in theme" : (name?.en ?? uiTheme.id)}`);
          }
          if (uiArrangement !== undefined) {
            const slots = Object.keys(uiArrangement).join(", ");
            zh.push(`uiArrangement（${slots}）`);
            en.push(`uiArrangement (${slots})`);
          }
          if (clientExtensions !== undefined) {
            const { enabled, disabled } = clientExtensions;
            if (enabled !== undefined) {
              zh.push(enabled ? "开启插件界面代码" : "停用全部插件界面代码");
              en.push(enabled ? "plugin interface code on" : "all plugin interface code stopped");
            }
            if (disabled !== undefined) {
              const list = disabled.length === 0 ? null : disabled.join(", ");
              zh.push(
                list === null ? "不再单独停用任何插件的界面代码" : `停用界面代码的插件：${list}`,
              );
              en.push(
                list === null
                  ? "no plugin's interface code stopped on its own"
                  : `interface code stopped for: ${list}`,
              );
            }
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
