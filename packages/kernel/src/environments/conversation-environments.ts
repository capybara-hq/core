import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { isInternalProvider, SandboxProviders } from "../sandbox/providers.js";
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
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "cloud"> &
      Partial<Pick<SandboxProviders, "forName">>,
    @Inject(EnvironmentAccess) private readonly access: Pick<EnvironmentAccess, "usable">,
    @Inject(EnvironmentsService)
    private readonly environments: Pick<EnvironmentsService, "ensureDefault">,
  ) {}

  /**
   * The environment a new conversation of `accountId` is bound to: the chosen one when it is
   * usable by the person (else `environment.not_found` / `environment.unavailable`, and nothing
   * is created); without a choice the IM default (IM only) or the person's default environment.
   * Null (unbound) for anonymous IM senders, and without a cloud sandbox provider when no usable
   * IM default (a connected machine's environment, say) applies.
   */
  async forNew(
    orgId: string,
    accountId: string,
    pick: NewConversationEnvironment = {},
  ): Promise<string | null> {
    if (pick.environmentId !== undefined) {
      return (await this.access.usable(orgId, accountId, pick.environmentId)).id;
    }
    if (pick.im !== true && this.providers.cloud() === undefined) return null;
    if (await this.isAnonymous(orgId, accountId)) return null;
    return this.defaultFor(orgId, accountId, pick.im === true);
  }

  /**
   * The environment a sandbox tool call of the conversation tree rooted at `rootConversationId`
   * enters, checked for its owner now. A conversation still unbound (created before
   * environments, or while no provider existed) is bound first, to the owner's IM default when it
   * is an IM thread, else to the owner's default environment; a racing call binds it once.
   * Throws `sandbox.unavailable` for a cloud environment (or none to bind) without a cloud
   * provider and for an anonymous IM conversation, and `environment.not_found` /
   * `environment.unavailable` when the owner may not use it now. A conversation bound to a
   * connected machine's environment (`@device`) does not need a cloud provider.
   */
  async forTool(orgId: string, rootConversationId: string): Promise<string> {
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
      if (chosen === null) throw sandboxUnavailable();
      environmentId = await this.bind(rootConversationId, chosen);
    }
    if (this.providers.cloud() === undefined && !(await this.isInternal(environmentId))) {
      throw sandboxUnavailable();
    }
    return (await this.access.usable(orgId, conv.account_id, environmentId)).id;
  }

  /**
   * Whether a sandbox tool call of the tree rooted at `rootConversationId` has a provider to run
   * on, for tool listings (ruling R8; no binding, no access check, never throws): a cloud
   * provider is loaded, or the environment the conversation is bound to (an unbound IM thread:
   * its owner's IM default) runs on a registered kernel provider (`@device`). A forbidden or gone
   * environment still counts: the call then says why.
   */
  async usableNow(orgId: string, rootConversationId: string): Promise<boolean> {
    if (this.providers.cloud() !== undefined) return true;
    const conv = await this.db
      .selectFrom("conversations")
      .select(["account_id", "environment_id"])
      .where("id", "=", rootConversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!conv) return false;
    let environmentId = conv.environment_id;
    if (environmentId === null) {
      if (!(await this.isImThread(rootConversationId))) return false;
      const row = await this.db
        .selectFrom("environment_defaults")
        .select("environment_id")
        .where("org_id", "=", orgId)
        .where("account_id", "=", conv.account_id)
        .executeTakeFirst();
      if (!row) return false;
      environmentId = row.environment_id;
    }
    const env = await this.db
      .selectFrom("environments")
      .select("provider")
      .where("id", "=", environmentId)
      .executeTakeFirst();
    const provider = env?.provider ?? null;
    return (
      provider !== null &&
      isInternalProvider(provider) &&
      this.providers.forName?.(provider) !== undefined
    );
  }

  /**
   * The person's IM default when `im` and it is still theirs, live, in this org and usable (the
   * table has no such guard), else their default environment (created when missing); null when
   * that is needed and there is no cloud provider to make or use it. The owner having left the org
   * reads as `environment.not_found`.
   */
  private async defaultFor(orgId: string, accountId: string, im: boolean): Promise<string | null> {
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
    if (this.providers.cloud() === undefined) return null;
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

  /** The environment runs on a kernel-internal provider (`@device`). */
  private async isInternal(environmentId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("environments")
      .select("provider")
      .where("id", "=", environmentId)
      .executeTakeFirst();
    const provider = row?.provider ?? null;
    return provider !== null && isInternalProvider(provider);
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
