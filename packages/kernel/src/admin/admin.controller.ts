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
import { ACCOUNTS, API_TOKENS, ORGS, SESSIONS, SETTINGS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { Account, AccountsService } from "../identity/accounts.js";
import type { ApiTokenService } from "../identity/api-tokens.js";
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
  DEPLOYMENT_SETTINGS,
  type DeploymentSettings,
  type SettingsService,
} from "../identity/settings.js";
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

const SettingsBody = DEPLOYMENT_SETTINGS.pick({ orgCreation: true }).required();

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
    @Inject(API_TOKENS) private readonly apiTokens: ApiTokenService,
    @Inject(ORGS) private readonly orgs: OrgsService,
    @Inject(SETTINGS) private readonly settings: SettingsService,
  ) {}

  /** 全部账号，按 id 升序分页（`after` 为上一页最后一个 id）。 */
  @Get("accounts")
  async listAccounts(
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ accounts: Account[] }> {
    return {
      accounts: await this.accounts.list({
        limit: q.limit,
        ...(q.after !== undefined && { after: q.after }),
      }),
    };
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
    const account = await this.accounts.update(
      accountId,
      patch,
      actor.account.id,
      patTokenId(actor),
    );
    if (body.status === "disabled") {
      // 鉴权每次请求实时读账号状态，停用已立即生效；这里再吊销凭据，重新启用后旧凭据也不复活
      await this.sessions.revokeAllForAccount(accountId);
      await this.apiTokens.revokeAllPersonal(accountId);
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
}
