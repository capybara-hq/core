import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { SandboxProviders } from "../sandbox/providers.js";
import { environmentNotFound, sandboxUnavailable } from "../sandbox/sandbox.service.js";
import { EnvironmentAccess } from "./access.js";
import { EnvironmentsService } from "./environments.service.js";

/** `details[0].reason` of the error an anonymous IM conversation's sandbox call gets. */
export const ANONYMOUS_NO_ENVIRONMENT = "anonymous";

/** Anonymous IM senders have no environment (spec §4.2 item 8): their sandbox tools are off. */
export const anonymousNoEnvironment = (): ApiError =>
  new ApiError(
    "sandbox.unavailable",
    "Anonymous IM senders have no environment, so the sandbox is not available",
    [{ reason: ANONYMOUS_NO_ENVIRONMENT }],
  );

/** How a new conversation picks its environment. */
export interface NewConversationEnvironment {
  /** The environment the person chose (the composer's picker); checked with `usable`. */
  environmentId?: string;
  /** An IM thread: the person's IM default (`environment_defaults`) when still usable. */
  im?: boolean;
}

/**
 * Which environment a conversation works in (spec 2026-11-07-environments-design §4.1 items 1, 3;
 * §4.2 items 8, 9, 12). A conversation is bound once, to an environment of its owner
 * (`conversations.account_id`): the one chosen at its first send, else the owner's IM default
 * (IM threads), else the owner's default environment. Its sub-agents use the root's. Access is
 * checked when it is bound and again on every sandbox tool call ({@link forTool}); only the owner
 * may use a personal environment, so a conversation never reaches another person's.
 */
@Injectable()
export class ConversationEnvironments {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SandboxProviders) private readonly providers: Pick<SandboxProviders, "current">,
    @Inject(EnvironmentAccess) private readonly access: Pick<EnvironmentAccess, "usable">,
    @Inject(EnvironmentsService)
    private readonly environments: Pick<EnvironmentsService, "ensureDefault">,
  ) {}

  /**
   * The environment a new conversation of `accountId` is bound to: the chosen one when it is
   * usable by the person (else `environment.not_found` / `environment.unavailable`, and nothing
   * is created); without a choice the IM default (IM only) or the person's default environment.
   * Null (unbound) without a sandbox provider and for anonymous IM senders.
   */
  async forNew(
    orgId: string,
    accountId: string,
    pick: NewConversationEnvironment = {},
  ): Promise<string | null> {
    if (pick.environmentId !== undefined) {
      return (await this.access.usable(orgId, accountId, pick.environmentId)).id;
    }
    if (this.providers.current() === undefined) return null;
    if (await this.isAnonymous(orgId, accountId)) return null;
    return this.defaultFor(orgId, accountId, pick.im === true);
  }

  /**
   * The environment a sandbox tool call of the conversation tree rooted at `rootConversationId`
   * enters, checked for its owner now. A conversation still unbound (created before
   * environments, or while no provider existed) is bound first, to the owner's IM default when it
   * is an IM thread, else to the owner's default environment; a racing call binds it once.
   * Throws `sandbox.unavailable` without a provider or for an anonymous IM conversation, and
   * `environment.not_found` / `environment.unavailable` when the owner may not use it now.
   */
  async forTool(orgId: string, rootConversationId: string): Promise<string> {
    if (this.providers.current() === undefined) throw sandboxUnavailable();
    const conv = await this.db
      .selectFrom("conversations")
      .select(["account_id", "environment_id"])
      .where("id", "=", rootConversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!conv) throw environmentNotFound();
    if (await this.isAnonymous(orgId, conv.account_id)) throw anonymousNoEnvironment();
    let environmentId = conv.environment_id;
    if (environmentId === null) {
      const im = await this.isImThread(rootConversationId);
      const chosen = await this.defaultFor(orgId, conv.account_id, im);
      environmentId = await this.bind(rootConversationId, chosen);
    }
    return (await this.access.usable(orgId, conv.account_id, environmentId)).id;
  }

  /**
   * The person's IM default when `im` and it is still theirs, live, in this org and usable (the
   * table has no such guard), else their default environment (created when missing). The owner
   * having left the org reads as `environment.not_found`.
   */
  private async defaultFor(orgId: string, accountId: string, im: boolean): Promise<string> {
    if (im) {
      const row = await this.db
        .selectFrom("environment_defaults")
        .select("environment_id")
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      if (row) {
        try {
          return (await this.access.usable(orgId, accountId, row.environment_id)).id;
        } catch (e) {
          if (!isEnvironmentGone(e)) throw e;
        }
      }
    }
    try {
      return await this.environments.ensureDefault(orgId, accountId);
    } catch (e) {
      if (e instanceof ApiError && e.code === "org.not_found") throw environmentNotFound();
      throw e;
    }
  }

  /** Binds an unbound conversation to `environmentId`; returns what it is bound to now. */
  @Transactional()
  private async bind(conversationId: string, environmentId: string): Promise<string> {
    await this.db
      .updateTable("conversations")
      .set({ environment_id: environmentId })
      .where("id", "=", conversationId)
      .where("environment_id", "is", null)
      .execute();
    const row = await this.db
      .selectFrom("conversations")
      .select("environment_id")
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
    return row.environment_id ?? environmentId;
  }

  /** The account is the org's anonymous IM guest (no person behind it). */
  private async isAnonymous(orgId: string, accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("org_anonymous_accounts")
      .select("account_id")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The conversation is (or was) an IM thread's. */
  private async isImThread(conversationId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("channel_threads")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}

const isEnvironmentGone = (e: unknown): boolean =>
  e instanceof ApiError &&
  (e.code === "environment.not_found" || e.code === "environment.unavailable");
