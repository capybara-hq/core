import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { ToolOutputs } from "../tools/outputs.js";
import { UUID_RE } from "../ui/registry.js";
import { ConversationAccess } from "./access.js";

/** 一次最多返回的字符数（也是默认值）：大存档按字符分页取。 */
export const OUTPUT_PAGE_MAX_CHARS = 200_000;

export interface OutputPage {
  id: string;
  /** 本页正文：`[offset, offset + limit)` 个字符。 */
  text: string;
  offset: number;
  /** 存档全文的字符数。 */
  totalChars: number;
  /** 下一页的 offset；已到末尾为 null。 */
  next: number | null;
}

const conversationNotFound = () => new ApiError("conversation.not_found", "Conversation not found");
const outputNotFound = () =>
  new ApiError("conversation.output_not_found", "Output not found or expired");

/**
 * 网页读工具输出存档（运行标签看全文）：先按会话流的规则判定会话可见（不可见 → `conversation.not_found`），
 * 再只在这个会话的存档里找（别的会话 / 过期 → `conversation.output_not_found`）。
 * 按字符分页（单行可能就很长，按行分页不能保证页大小）；id 不是 UUID 时直接 404，不打到数据库。
 */
@Injectable()
export class ConversationOutputs {
  constructor(
    /** 会话可见性（与会话 SSE 流同一判定）。 */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    /** 读本会话未过期的存档：不存在 / 过期 / 属于别的会话 → null。 */
    @Inject(ToolOutputs) private readonly outputs: Pick<ToolOutputs, "load">,
  ) {}

  async read(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    outputId: string,
    page: { offset: number; limit: number },
  ): Promise<OutputPage> {
    if (!UUID_RE.test(conversationId)) throw conversationNotFound();
    if (!(await this.access.isAccessible(orgId, conversationId, viewerAccountId)))
      throw conversationNotFound();
    if (!UUID_RE.test(outputId)) throw outputNotFound();
    const content = await this.outputs.load({ orgId, conversationId }, outputId);
    if (content === null) throw outputNotFound();
    const offset = Math.min(page.offset, content.length);
    const end = Math.min(content.length, offset + page.limit);
    return {
      id: outputId,
      text: content.slice(offset, end),
      offset,
      totalChars: content.length,
      next: end < content.length ? end : null,
    };
  }
}
