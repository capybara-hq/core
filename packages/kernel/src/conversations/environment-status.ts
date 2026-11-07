import { Inject, Injectable } from "@nestjs/common";
import { EnvironmentsService, type EnvironmentView } from "../environments/environments.service.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { UUID_RE } from "../ui/registry.js";
import { ConversationAccess } from "./access.js";
import { ConversationsService } from "./conversations.service.js";

/**
 * The environment a conversation works in, for its page (environments spec §9: shown read only):
 * a conversation the viewer may not see → `conversation.not_found`. A sub-agent shows its root
 * conversation's environment. Null while the conversation is unbound, or when its environment is
 * deleted or no longer its owner's (its sandbox tools then fail).
 */
@Injectable()
export class ConversationEnvironmentStatus {
  constructor(
    /** Who may see the conversation (the rule of its event stream). */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    /** The conversation whose environment it works in: a sub-agent's root, else itself. */
    @Inject(ConversationsService)
    private readonly conversations: Pick<ConversationsService, "sandboxConversationOf">,
    @Inject(EnvironmentsService) private readonly environments: Pick<EnvironmentsService, "get">,
    @Inject(KernelDb) private readonly db: KernelDb,
  ) {}

  async get(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<EnvironmentView | null> {
    if (
      !UUID_RE.test(conversationId) ||
      !(await this.access.isAccessible(orgId, conversationId, viewerAccountId))
    ) {
      throw new ApiError("conversation.not_found", "Conversation not found");
    }
    // a sub-agent works in its root conversation's environment (at every depth)
    const root = await this.conversations.sandboxConversationOf(orgId, conversationId);
    const conv = await this.db
      .selectFrom("conversations")
      .select(["account_id", "environment_id"])
      .where("id", "=", root)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!conv?.environment_id) return null;
    try {
      // the environment as its owner sees it (only the owner may use a personal environment)
      return await this.environments.get(orgId, conv.account_id, conv.environment_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "environment.not_found") return null;
      throw e;
    }
  }
}
