import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { LegacyPorts } from "../lifecycle/legacy-ports.js";
import { UUID_RE } from "../ui/registry.js";
import { ConversationAccess } from "./access.js";
import { ConversationsService } from "./conversations.service.js";

export interface SandboxStatusView {
  status: "running" | "suspended";
  lastUsedAt: string;
}

/**
 * 对话沙箱的状态（网页上下文标签，M5 T11）：会话不可见 → `conversation.not_found`；
 * 没有可用的沙箱（未创建、已销毁、正在创建）→ `sandbox.not_found`（界面显示「未创建」）。
 */
@Injectable()
export class ConversationSandboxStatus {
  constructor(
    /** 会话可见性（与会话 SSE 流同一判定）。 */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    /** The conversation whose sandbox it works in: a sub-agent's parent, else itself. */
    @Inject(ConversationsService)
    private readonly conversations: Pick<ConversationsService, "sandboxConversationOf">,
    /** R7 (Task 3.8): the sandbox service (`status`). */
    @Inject(LegacyPorts) private readonly ports: LegacyPorts,
  ) {}

  async get(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<SandboxStatusView> {
    if (
      !UUID_RE.test(conversationId) ||
      !(await this.access.isAccessible(orgId, conversationId, viewerAccountId))
    ) {
      throw new ApiError("conversation.not_found", "Conversation not found");
    }
    // a sub-agent works in its parent conversation's sandbox (sub-agents spec §10.1)
    const sandboxConv = await this.conversations.sandboxConversationOf(orgId, conversationId);
    const s = await this.ports.sandbox.status(orgId, sandboxConv);
    if (!s) throw new ApiError("sandbox.not_found", "This conversation has no sandbox");
    return { status: s.status, lastUsedAt: s.lastUsedAt.toISOString() };
  }
}
