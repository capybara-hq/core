import type { LocalizedName, Logger } from "@capybara-hq/plugin-sdk";
import { Controller, Get, HttpCode, Inject, Patch, Post, Put } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "../errors.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { PluginIcons } from "../extensions/plugin-icons.js";
import { type Account, AccountsService } from "../identity/accounts.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { SessionService } from "../identity/sessions.js";
import { type DeploymentSettings, SettingsService } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import {
  type ModelDisabledPatch,
  ModelDisabledPatchDto,
  type ModelProviderParams,
  ModelProviderParamsDto,
} from "../models/enablement.controller.js";
import { type ModelDisableResult, ModelEnablement } from "../models/enablement.js";
import {
  MODEL_PRICE_PUT,
  type ModelPrice,
  type ModelPricePut,
  PricesService,
} from "../models/prices.js";
import { purposeTargetOf } from "../models/purposes.controller.js";
import {
  ModelPurposesService,
  type PurposeListing,
  type PurposePut,
  PurposePutDto,
  withDeclaredByNames,
} from "../models/purposes.js";
import { type Member, MembersService } from "../orgs/members.service.js";
import { type Org, OrgsService } from "../orgs/orgs.service.js";
import { ProviderRegistry, type ProviderStatus } from "../runtime/providers.js";
import {
  AccountListQuery,
  AccountParams,
  AdminOrgParams,
  CreateAccountBody,
  DeploymentSettingsBody,
  PurposeParams,
  UpdateAccountBody,
} from "./admin.schemas.js";
import { type LimitDefaults, limitDefaults } from "./limit-defaults.js";

class AccountListQueryDto extends createZodDto(AccountListQuery, "AccountListQuery") {}
class CreateAccountBodyDto extends createZodDto(CreateAccountBody, "CreateAccountBody") {}
class UpdateAccountBodyDto extends createZodDto(UpdateAccountBody, "UpdateAccountBody") {}
class AccountParamsDto extends createZodDto(AccountParams, "AccountParams") {}
class AdminOrgParamsDto extends createZodDto(AdminOrgParams, "AdminOrgParams") {}
class PurposeParamsDto extends createZodDto(PurposeParams, "PurposeParams") {}
class DeploymentSettingsBodyDto extends createZodDto(
  DeploymentSettingsBody,
  "DeploymentSettingsPatch",
) {}
// a union schema: a DTO value rather than a class (a class cannot extend a union instance type)
const ModelPriceBody = createZodDto(MODEL_PRICE_PUT, "ModelPricePut");

/**
 * 超级管理员端点（`/api/v1/admin/*`）：只接受超级管理员的 Web 会话或个人令牌；
 * 服务令牌一律 `forbidden`（未标 `@AllowService`）。
 */
@Controller("api/v1/admin")
@SuperAdmin()
export class AdminController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PricesService) private readonly prices: PricesService,
    @Inject(ModelPurposesService) private readonly purposes: ModelPurposesService,
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(ModelEnablement) private readonly enablement: ModelEnablement,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  /**
   * 全部账号，按 id 升序分页：`next` 为下一页的游标（作为 `after` 传回），没有更多时为 null。
   * 多取一条判断是否还有下一页。
   */
  @Get("accounts")
  async listAccounts(
    @ZQuery(AccountListQueryDto) q: z.infer<typeof AccountListQuery>,
  ): Promise<{ accounts: Account[]; next: string | null }> {
    const rows = await this.accounts.list({
      limit: q.limit + 1,
      ...(q.after !== undefined && { after: q.after }),
    });
    const accounts = rows.slice(0, q.limit);
    const next = rows.length > q.limit ? (accounts.at(-1)?.id ?? null) : null;
    return { accounts, next };
  }

  @Post("accounts")
  @HttpCode(201)
  async createAccount(
    @CurrentPrincipal() principal: Principal,
    @ZBody(CreateAccountBodyDto) body: z.infer<typeof CreateAccountBody>,
  ): Promise<{ account: Account }> {
    const actor = requireUser(principal);
    const account = await this.accounts.createByAdmin(
      {
        login: body.login,
        password: body.password,
        displayName: body.displayName,
        ...(body.email !== undefined && { email: body.email }),
        ...(body.superAdmin !== undefined && { superAdmin: body.superAdmin }),
      },
      actor.account.id,
      patTokenId(actor),
    );
    return { account };
  }

  /** 改显示名 / 状态 / 超级管理员；停用时同时吊销该账号的全部会话与个人令牌。 */
  @Patch("accounts/:accountId")
  async updateAccount(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AccountParamsDto) { accountId }: z.infer<typeof AccountParams>,
    @ZBody(UpdateAccountBodyDto) body: z.infer<typeof UpdateAccountBody>,
  ): Promise<{ account: Account }> {
    const actor = requireUser(principal);
    const patch: Parameters<AccountsService["update"]>[1] = {
      ...(body.displayName !== undefined && { displayName: body.displayName }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.isSuperAdmin !== undefined && { isSuperAdmin: body.isSuperAdmin }),
    };
    // 停用时账号状态、会话与个人令牌的吊销在同一个 PG 事务里完成
    const { account, revokedSessionIds } = await this.accounts.updateAccount(
      accountId,
      patch,
      actor.account.id,
      patTokenId(actor),
    );
    try {
      await this.sessions.markRevoked(revokedSessionIds);
    } catch (err) {
      // Redis 标记只是快速路径：鉴权每次都查 PG revoked_at，这些会话已经无法使用
      this.log.warn("failed to write session revocation markers after account deactivation", {
        accountId,
        err,
      });
    }
    return { account };
  }

  /**
   * 全部组织的元数据与成员数（不含成员明细）, with the deployment's defaults of the limits an org
   * can be given its own value of (the org limits dialog shows them for the values left empty).
   */
  @Get("orgs")
  async listOrgs(): Promise<{
    orgs: (Org & { memberCount: number })[];
    limitDefaults: LimitDefaults;
  }> {
    return { orgs: await this.orgs.listAll(), limitDefaults: limitDefaults(this.config) };
  }

  /**
   * The members of any live org (the agent owner transfer picks the new owner from them); the super
   * admin need not be a member. A missing or deleted org → `org.not_found`.
   */
  @Get("orgs/:orgId/members")
  async orgMembers(
    @ZParam(AdminOrgParamsDto) { orgId }: z.infer<typeof AdminOrgParams>,
  ): Promise<{ members: Member[] }> {
    if ((await this.orgs.get(orgId)) === undefined) {
      throw new ApiError("org.not_found", "Organization not found");
    }
    return { members: await this.members.list(orgId) };
  }

  @Get("settings")
  async getSettings(): Promise<DeploymentSettings> {
    return this.settings.get();
  }

  @Put("settings")
  async putSettings(
    @CurrentPrincipal() principal: Principal,
    @ZBody(DeploymentSettingsBodyDto) body: z.infer<typeof DeploymentSettingsBody>,
  ): Promise<DeploymentSettings> {
    const actor = requireUser(principal);
    return this.settings.update(body, actor.account.id, patTokenId(actor));
  }

  /**
   * 模型供应商与模型（后台「模型」页）：每个供应商带状态，列模型失败的标 `error`，不影响其他供应商；
   * 一并返回价格表与币种（改价仍走 `PUT /admin/model-prices`）。Each provider carries its extension's
   * display name (null when it has none); every model of the platform's list carries `disabled`
   * (the platform's disabled list, spec B §5.3).
   */
  @Get("models")
  async getModels(): Promise<{
    providers: (ProviderStatus & { displayName: LocalizedName | null; icon: string | null })[];
    prices: ModelPrice[];
    currency: string;
  }> {
    const [providers, prices] = await Promise.all([
      this.registry.listWithStatus(),
      this.getModelPrices(),
    ]);
    const plugins = providers.map((p) => p.plugin);
    const [names, icons] = await Promise.all([
      this.displayNames.many(plugins),
      this.icons.many(plugins, { kind: "admin" }),
    ]);
    return {
      providers: providers.map((p) => ({
        ...p,
        displayName: names.get(p.plugin) ?? null,
        icon: icons.get(p.plugin) ?? null,
      })),
      ...prices,
    };
  }

  /**
   * The platform's disabled models of one provider (spec B §5.3): disables and enables the ids the
   * body names (others keep their state); such a model is invisible to every org. The response
   * lists the agents and purposes, across orgs, that now point at a newly disabled model (the
   * disable is not refused for them).
   */
  @Patch("models/:provider/disabled")
  async patchModelsDisabled(
    @CurrentPrincipal() principal: Principal,
    @ZParam(ModelProviderParamsDto) params: z.infer<typeof ModelProviderParams>,
    @ZBody(ModelDisabledPatchDto) body: z.infer<typeof ModelDisabledPatch>,
  ): Promise<ModelDisableResult> {
    const actor = requireUser(principal);
    return this.enablement.setPlatform(params.provider, body, {
      accountId: actor.account.id,
      tokenId: patTokenId(actor),
    });
  }

  /** 模型价格表（每百万 token）与币种（部署设置 `priceCurrency`）。 */
  @Get("model-prices")
  async getModelPrices(): Promise<{ prices: ModelPrice[]; currency: string }> {
    const [prices, settings] = await Promise.all([this.prices.list(), this.settings.get()]);
    return { prices, currency: settings.priceCurrency };
  }

  /** 设置一个模型的价格，或 `{provider, model, price: null}` 删除；返回更新后的价格表。 */
  @Put("model-prices")
  async putModelPrice(
    @CurrentPrincipal() principal: Principal,
    @ZBody(ModelPriceBody) body: ModelPricePut,
  ): Promise<{ prices: ModelPrice[]; currency: string }> {
    const actor = requireUser(principal);
    await this.prices.put(body, actor.account.id, patTokenId(actor));
    return this.getModelPrices();
  }

  /** 模型用途与部署默认映射（`override` 一律为 null；组织覆盖在组织侧接口）。 */
  @Get("model-purposes")
  async getModelPurposes(): Promise<{ purposes: PurposeListing[] }> {
    return { purposes: await withDeclaredByNames(await this.purposes.list(), this.displayNames) };
  }

  /** 设置一个用途的部署默认，或 `target: null` 清除。 */
  @Put("model-purposes/:purpose")
  async putModelPurpose(
    @CurrentPrincipal() principal: Principal,
    @ZParam(PurposeParamsDto) { purpose }: z.infer<typeof PurposeParams>,
    @ZBody(PurposePutDto) body: PurposePut,
  ): Promise<{ purpose: PurposeListing }> {
    const actor = requireUser(principal);
    const view = await this.purposes.setDefault(
      purpose,
      purposeTargetOf(body),
      actor.account.id,
      patTokenId(actor),
    );
    const [listing] = await withDeclaredByNames([view], this.displayNames);
    return { purpose: listing as PurposeListing };
  }
}
