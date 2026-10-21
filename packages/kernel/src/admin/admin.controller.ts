import type { Logger } from "@capybara-hq/plugin-sdk";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { ACCOUNTS, KERNEL_LOG, ORGS, PRICES, SESSIONS, SETTINGS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { Account, AccountsService } from "../identity/accounts.js";
import { MAX_PASSWORD_LENGTH } from "../identity/login.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type { SessionService } from "../identity/sessions.js";
import {
  DEPLOYMENT_SETTINGS_PATCH,
  type DeploymentSettings,
  type SettingsService,
} from "../identity/settings.js";
import {
  MODEL_PRICE_PUT,
  type ModelPrice,
  type ModelPricePut,
  type PricesService,
} from "../models/prices.js";
import type { Org, OrgsService } from "../orgs/orgs.service.js";

const ListQuery = z.object({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const CreateAccountBody = z.object({
  login: z.string().min(1).max(64),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  displayName: z.string().trim().min(1).max(100),
  email: z.email().max(254).optional(),
  enterpriseAdmin: z.boolean().optional(),
});

const UpdateAccountBody = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  isEnterpriseAdmin: z.boolean().optional(),
});

/** 至少给出一个键；`runConcurrencyOverrides` 按组织合并，值为 null 删除该组织的覆盖。 */
const SettingsBody = DEPLOYMENT_SETTINGS_PATCH.refine((b) => Object.keys(b).length > 0, {
  message: "at least one setting is required",
});

/**
 * 企业管理员端点（`/api/v1/admin/*`）：只接受企业管理员的 Web 会话或个人令牌；
 * 服务令牌一律 `forbidden`（未标 `@AllowService`）。
 */
@Controller("api/v1/admin")
@EnterpriseAdmin()
export class AdminController {
  constructor(
    @Inject(ACCOUNTS) private readonly accounts: AccountsService,
    @Inject(SESSIONS) private readonly sessions: SessionService,
    @Inject(KERNEL_LOG) private readonly log: Logger,
    @Inject(ORGS) private readonly orgs: OrgsService,
    @Inject(SETTINGS) private readonly settings: SettingsService,
    @Inject(PRICES) private readonly prices: PricesService,
  ) {}

  /**
   * 全部账号，按 id 升序分页：`next` 为下一页的游标（作为 `after` 传回），没有更多时为 null。
   * 多取一条判断是否还有下一页。
   */
  @Get("accounts")
  async listAccounts(
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
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
    @Body(new ZodPipe(CreateAccountBody)) body: z.infer<typeof CreateAccountBody>,
  ): Promise<{ account: Account }> {
    const actor = requireUser(principal);
    const account = await this.accounts.createByAdmin(
      {
        login: body.login,
        password: body.password,
        displayName: body.displayName,
        ...(body.email !== undefined && { email: body.email }),
        ...(body.enterpriseAdmin !== undefined && { enterpriseAdmin: body.enterpriseAdmin }),
      },
      actor.account.id,
      patTokenId(actor),
    );
    return { account };
  }

  /** 改显示名 / 状态 / 企业管理员；停用时同时吊销该账号的全部会话与个人令牌。 */
  @Patch("accounts/:accountId")
  async updateAccount(
    @CurrentPrincipal() principal: Principal,
    @Param("accountId") accountId: string,
    @Body(new ZodPipe(UpdateAccountBody)) body: z.infer<typeof UpdateAccountBody>,
  ): Promise<{ account: Account }> {
    const actor = requireUser(principal);
    const patch: Parameters<AccountsService["update"]>[1] = {
      ...(body.displayName !== undefined && { displayName: body.displayName }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.isEnterpriseAdmin !== undefined && { isEnterpriseAdmin: body.isEnterpriseAdmin }),
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

  /** 全部组织的元数据与成员数（不含成员明细）。 */
  @Get("orgs")
  async listOrgs(): Promise<{ orgs: (Org & { memberCount: number })[] }> {
    return { orgs: await this.orgs.listAll() };
  }

  @Get("settings")
  async getSettings(): Promise<DeploymentSettings> {
    return this.settings.get();
  }

  @Put("settings")
  async putSettings(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(SettingsBody)) body: z.infer<typeof SettingsBody>,
  ): Promise<DeploymentSettings> {
    const actor = requireUser(principal);
    return this.settings.update(body, actor.account.id, patTokenId(actor));
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
    @Body(new ZodPipe(MODEL_PRICE_PUT)) body: ModelPricePut,
  ): Promise<{ prices: ModelPrice[]; currency: string }> {
    const actor = requireUser(principal);
    await this.prices.put(body, actor.account.id, patTokenId(actor));
    return this.getModelPrices();
  }
}
