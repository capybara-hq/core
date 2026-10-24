import { apiFetch } from "./api";
import type { Approval } from "./approvals";
import type { CatalogRequest } from "./catalog";
import type { SkillChange } from "./skills";

/**
 * 收件箱（内核 `GET /orgs/:orgId/inbox`，按类型汇总）：当前用户能处理的待处理工具审批与
 * 作为 agent 负责人能决定的技能变更，以及（组织管理员）成员提交的目录申请；新的在前，最多 100 项，`truncated` 表示还有更多。
 */
export type InboxItem =
  | { type: "tool_approval"; id: string; createdAt: string; approval: Approval }
  | { type: "skill_change"; id: string; createdAt: string; skillChange: SkillChange }
  | { type: "catalog_request"; id: string; createdAt: string; request: CatalogRequest };

export interface InboxView {
  items: InboxItem[];
  truncated: boolean;
}

export const listInbox = (orgId: string) =>
  apiFetch<InboxView>(`/api/v1/orgs/${encodeURIComponent(orgId)}/inbox`);
