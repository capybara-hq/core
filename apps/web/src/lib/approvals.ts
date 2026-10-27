import { apiFetch } from "./api";

/**
 * 内核审批 API 的类型（`packages/kernel/src/tools/approvals.controller.ts` / `approvals.service.ts`；
 * 只声明界面用到的字段）。Web 层不 import 内核代码。
 */

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type ApprovalScope = "once" | "session" | "always";

export const APPROVAL_SCOPES = ["once", "session", "always"] as const satisfies ApprovalScope[];

export interface Approval {
  id: string;
  conversationId: string;
  runId: string;
  callId: string;
  toolKey: string;
  /** 来源内的工具原名（连接器工具为连接器里的名字）。 */
  toolName: string;
  connector: { id: string; name: string; slug: string } | null;
  agent: { id: string; name: string };
  input: unknown;
  /** 指定处理人；为 null 时按角色升级（只能「仅本次」）。 */
  requestedFor: string | null;
  approverRole: string | null;
  status: ApprovalStatus;
  scope: ApprovalScope | null;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  /**
   * Path of the conversation in the web app (no locale prefix); a sub-agent's approval links to
   * its parent conversation with `?subagent=<child id>`.
   */
  conversationPath: string;
  /** Set when the approval belongs to a sub-agent: the conversation it was dispatched from. */
  parentConversationId?: string;
  initiatorAccountId: string;
}

export interface ToolGrant {
  agentId: string;
  agentName: string;
  toolKey: string;
  createdAt: string;
}

/** 可选的批准范围：按角色升级的审批只能「仅本次」。 */
export const scopesFor = (a: Pick<Approval, "requestedFor">): ApprovalScope[] =>
  a.requestedFor === null ? ["once"] : [...APPROVAL_SCOPES];

/** 参数的 JSON 展示（两空格缩进；无法序列化时退回 String）。 */
export function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;

export const listApprovals = (orgId: string, status?: ApprovalStatus) =>
  apiFetch<{ approvals: Approval[] }>(
    `${base(orgId)}/approvals${status ? `?status=${status}` : ""}`,
  );

export const getApproval = (orgId: string, id: string) =>
  apiFetch<{ approval: Approval }>(`${base(orgId)}/approvals/${encodeURIComponent(id)}`);

export const decideApproval = (
  orgId: string,
  id: string,
  body: { decision: "approve" | "deny"; scope?: ApprovalScope; note?: string; reason?: string },
) =>
  apiFetch<{ approval: Omit<Approval, "toolName" | "connector" | "agent"> }>(
    `${base(orgId)}/approvals/${encodeURIComponent(id)}/decision`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const listToolGrants = (orgId: string) =>
  apiFetch<{ grants: ToolGrant[] }>(`${base(orgId)}/me/tool-grants`);

export const revokeToolGrant = (orgId: string, agentId: string, toolKey: string) =>
  apiFetch<void>(
    `${base(orgId)}/me/tool-grants/${encodeURIComponent(agentId)}/${encodeURIComponent(toolKey)}`,
    { method: "DELETE" },
  );
