import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AccountListQuery, AccountParams, CreateAccountBody } from "../../admin/admin.schemas.js";
import { ApiError } from "../../errors.js";
import { type Account, AccountsService } from "../../identity/accounts.js";
import { InitialPasswords } from "../../identity/initial-passwords.js";
import { SessionService } from "../../identity/sessions.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import { OrgsService } from "../../orgs/orgs.service.js";
import { defineOperation, type OperationContext, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { named } from "./summary.js";

const PAGE = 50;

const AccountId = AccountParams.shape.accountId.describe("The account id (accounts.list).");

/** What the tool result says instead of the password (model-visible English). */
export const INITIAL_PASSWORD_NOTE =
  "The kernel generated a one-time initial password. It is shown once, on the web, to the person who approved this call (the approval card in this conversation); it is not available to you, so never ask for it or make one up. If it is not read within 24 hours it is lost: disable the account and create it again. The account must change it at first sign-in.";

/** An account as a detail returns it (the admin console's account fields). */
const accountView = (a: Account, login: string | null) => ({
  id: a.id,
  login,
  displayName: a.displayName,
  email: a.email,
  status: a.status,
  superAdmin: a.isSuperAdmin,
  mustChangePassword: a.mustChangePassword,
  createdAt: a.createdAt,
});

/** The account's name as a card summary quotes it: display name and login. */
const quoted = (a: { displayName: string }, login: string | null | undefined) =>
  login ? `${named(a.displayName)} (${named(login)})` : named(a.displayName);

/**
 * Account operations of the `Platform` tool (spec §14.2, admin console): the super admin lists,
 * reads, creates, disables and enables accounts, only through their own private agent
 * (`availability`). Creating takes no password: the kernel generates a one-time one, the account
 * must change it at first sign-in, and only the approving person sees it, on the web (spec §14.5
 * item 2); the result, the events, the audit and the logs never carry it. The super-admin flag
 * stays a human-only change (a role change).
 */
@Injectable()
export class AccountsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(InitialPasswords) private readonly passwords: InitialPasswords,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
  ) {}

  private async account(id: string): Promise<Account> {
    const a = await this.accounts.get(id);
    if (!a) throw new ApiError("account.not_found", "Account not found");
    return a;
  }

  /** Refuses a status change that cannot or need not run, before the card. */
  private async statusPrecheck(
    accountId: string,
    status: "active" | "disabled",
    ctx: OperationContext,
  ): Promise<PrecheckResult> {
    const r = await precheckBy(() => this.account(accountId));
    if (!r.ok) return r;
    const a = await this.account(accountId);
    if (a.status === status) {
      return {
        ok: false,
        code: "account.no_change",
        message: `The account is ${status} already`,
      };
    }
    if (status === "disabled" && accountId === ctx.actorAccountId) {
      return {
        ok: false,
        code: "account.self",
        message: "You cannot disable your own account through your agent",
      };
    }
    if (
      status === "disabled" &&
      a.isSuperAdmin &&
      a.status === "active" &&
      (await this.accounts.countSuperAdmins()) <= 1
    ) {
      return {
        ok: false,
        code: "account.last_super_admin",
        message: "This is the last active super admin",
      };
    }
    return { ok: true };
  }

  private async setStatus(
    operation: string,
    accountId: string,
    status: "active" | "disabled",
    ctx: OperationContext,
  ) {
    const { account, revokedSessionIds } = await this.accounts.updateAccount(
      accountId,
      { status },
      ctx.actorAccountId,
      undefined,
      { auditDetail: viaAgent(operation, ctx) },
    );
    try {
      await this.sessions.markRevoked(revokedSessionIds);
    } catch (err) {
      // the Redis markers are only the fast path: auth reads PG revoked_at on every request
      this.log.warn("failed to write session revocation markers after account deactivation", {
        accountId,
        err,
      });
    }
    const login = (await this.accounts.localLogins([account.id])).get(account.id) ?? null;
    return { account: accountView(account, login) };
  }

  private async statusSummary(accountId: string, zh: string, en: string) {
    const a = await this.accounts.get(accountId);
    if (!a) return { zh: `${zh}账号 ${accountId}`, en: `${en} account ${accountId}` };
    const login = (await this.accounts.localLogins([a.id])).get(a.id);
    return { zh: `${zh}账号「${quoted(a, login)}」`, en: `${en} account "${quoted(a, login)}"` };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "accounts.list",
        description:
          "List the platform's accounts (super admin), one compact row each: id, display name, state (active or disabled), login, email and whether it is a super admin. Ordered by id; pages by 50: pass the returned next as params.after. Details come from accounts.get.",
        input: z
          .object({ after: AccountListQuery.shape.after.unwrap().max(100).optional() })
          .strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/accounts"],
        // the page size is fixed at 50 (compact rows)
        omits: ["limit"],
        confirm: "read",
        run: async (input) => {
          const rows = await this.accounts.list({
            limit: PAGE + 1,
            ...(input.after !== undefined && { after: input.after }),
          });
          const page = rows.slice(0, PAGE);
          const logins = await this.accounts.localLogins(page.map((a) => a.id));
          return {
            items: page.map((a) => ({
              id: a.id,
              name: a.displayName,
              state: a.status,
              login: logins.get(a.id) ?? null,
              email: a.email,
              superAdmin: a.isSuperAdmin,
            })),
            next: rows.length > PAGE ? (page.at(-1)?.id ?? null) : null,
          };
        },
      }),
      defineOperation({
        id: "accounts.get",
        description:
          "Read one account (super admin): login, display name, email, state, whether it is a super admin, whether it still has to change a generated initial password, when it was created, and the orgs it belongs to with its role in each.",
        input: z.object({ accountId: AccountId }).strict(),
        example: { accountId: "00000000-0000-4000-8000-000000000000" },
        authz: { superAdmin: true },
        mirrors: [],
        confirm: "read",
        errors: [
          {
            code: "account.not_found",
            next: "Look the account up with accounts.list and pass its id.",
          },
        ],
        run: async (input) => {
          const a = await this.account(input.accountId);
          const [logins, orgs] = await Promise.all([
            this.accounts.localLogins([a.id]),
            this.orgs.listForAccount(a.id),
          ]);
          return {
            account: accountView(a, logins.get(a.id) ?? null),
            orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })),
          };
        },
      }),
      defineOperation({
        id: "accounts.create",
        description:
          "Create a local sign-in account (super admin): a login (3-64 characters: letters, digits, . _ @ + -), a display name and an optional email. You pass no password: the kernel generates a one-time initial password, shows it once to the person who approves this call, on the web (the approval card); it is lost if not read within 24 hours (then disable the account and create it again). The account must change it at first sign-in. The account is never a super admin; that and org memberships are set by a person on the web (add it to an org with an invitation).",
        input: CreateAccountBody.pick({ login: true, displayName: true, email: true }).strict(),
        example: { login: "alice", displayName: "Alice Chen", email: "alice@example.com" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/accounts"],
        // the password is generated by the kernel; the super-admin flag is a role change (human-only)
        omits: ["password", "superAdmin"],
        confirm: "platform",
        errors: [
          {
            code: "account.login_taken",
            next: "Choose another login, or use the existing account (accounts.list).",
          },
          {
            code: "account.create_needs_approval",
            next: "Call it from a conversation with your private agent, where you approve the call yourself, or create the account on the web (admin console, Accounts).",
          },
          {
            code: "validation_failed",
            next: "Fix the login, display name or email as the message says, then call again.",
          },
        ],
        precheck: (i) => precheckBy(() => this.accounts.assertLoginFree(i.login)),
        summary: (i) => ({
          zh: `新建账号「${quoted(i, i.login)}」，初始密码由平台生成，批准后仅向你显示一次`,
          en: `Create account "${quoted(i, i.login)}"; the platform generates the initial password and shows it once to you after approval`,
        }),
        run: async (input, ctx) => {
          if (ctx.callId === undefined || ctx.runId === null) {
            // the password reaches the approver through the approved call; without one it could
            // never be shown, so nothing is created
            throw new ApiError(
              "account.create_needs_approval",
              "accounts.create runs only as a Platform call you approve in a conversation",
            );
          }
          const account = await this.passwords.createAccount(
            {
              login: input.login,
              displayName: input.displayName,
              ...(input.email !== undefined && { email: input.email }),
            },
            ctx.actorAccountId,
            {
              conversationId: ctx.conversationId,
              runId: ctx.runId,
              callId: ctx.callId,
              recipientAccountId: ctx.actorAccountId,
            },
            viaAgent("accounts.create", ctx),
          );
          const login = (await this.accounts.localLogins([account.id])).get(account.id) ?? null;
          return { account: accountView(account, login), initialPassword: INITIAL_PASSWORD_NOTE };
        },
      }),
      defineOperation({
        id: "accounts.disable",
        description:
          "Disable an account (super admin): it can no longer sign in, and its sessions and personal access tokens are revoked at once (enabling it again does not bring them back). You cannot disable your own account or the last active super admin.",
        input: z.object({ accountId: AccountId }).strict(),
        example: { accountId: "00000000-0000-4000-8000-000000000000" },
        authz: { superAdmin: true },
        mirrors: ["PATCH /api/v1/admin/accounts/:accountId"],
        // only the status, set by the operation; the display name and the super-admin flag (a role
        // change, human-only) are changed on the web
        omits: ["displayName", "status", "isSuperAdmin"],
        confirm: "platform",
        errors: [
          {
            code: "account.not_found",
            next: "Look the account up with accounts.list and pass its id.",
          },
          {
            code: "account.last_super_admin",
            next: "Make another account a super admin on the web first (admin console, Accounts).",
          },
          { code: "account.self", next: "Ask another super admin to do it on the web." },
          { code: "account.no_change", next: "Nothing to do: the account is disabled already." },
        ],
        precheck: (i, ctx) => this.statusPrecheck(i.accountId, "disabled", ctx),
        summary: (i) => this.statusSummary(i.accountId, "停用", "Disable"),
        run: (input, ctx) => this.setStatus("accounts.disable", input.accountId, "disabled", ctx),
      }),
      defineOperation({
        id: "accounts.enable",
        description:
          "Enable a disabled account again (super admin): it can sign in again with its password; its earlier sessions and tokens stay revoked.",
        input: z.object({ accountId: AccountId }).strict(),
        example: { accountId: "00000000-0000-4000-8000-000000000000" },
        authz: { superAdmin: true },
        mirrors: ["PATCH /api/v1/admin/accounts/:accountId"],
        omits: ["displayName", "status", "isSuperAdmin"],
        confirm: "platform",
        errors: [
          {
            code: "account.not_found",
            next: "Look the account up with accounts.list and pass its id.",
          },
          { code: "account.no_change", next: "Nothing to do: the account is active already." },
        ],
        precheck: (i, ctx) => this.statusPrecheck(i.accountId, "active", ctx),
        summary: (i) => this.statusSummary(i.accountId, "启用", "Enable"),
        run: (input, ctx) => this.setStatus("accounts.enable", input.accountId, "active", ctx),
      }),
    ]);
  }
}
