import { apiFetch } from "./api";

/**
 * 内核审批 API 的类型（`packages/kernel/src/tools/approvals.controller.ts` / `approvals.service.ts`；
 * 只声明界面用到的字段）。Web 层不 import 内核代码。
 */

/** `skipped`: a network ask the person answered with a message instead (network ask spec §6.7). */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "skipped";
export type ApprovalScope = "once" | "session" | "always";

export const APPROVAL_SCOPES = ["once", "session", "always"] as const satisfies ApprovalScope[];

/**
 * A network ask's detail (network ask spec §6.1): a command on a device was refused these hosts by
 * the device's own policy. `grantedHosts` / `outcome` / `fallback` are set once decided.
 */
export interface NetworkApprovalDetail {
  deviceId: string;
  hosts: { host: string; port: number }[];
  command: string;
  description: string | null;
  /** The hosts the decision allowed (the checked subset). */
  grantedHosts?: string[];
  /** `once_fallback`: "always" was chosen but the device took it as "this time". */
  outcome?: "once" | "always" | "once_fallback";
  /** Why "always" fell back to "this time". */
  fallback?: "offline" | "refused" | "unsupported";
  /**
   * While pending: the last "always" whose device change did not take effect (`failed`, with the
   * device's reason), that the device did not confirm (`unknown`), or that the device applied but
   * whose chooser can no longer decide the request (`applied_undecided`).
   */
  attempt?: { outcome: "failed" | "unknown" | "applied_undecided"; message: string };
}

/**
 * A command review ask's detail (auto mode spec §5.4): a shell command, or a file write outside
 * the workspace, held until the device owner allows it. `command` holds the full command here (the
 * timeline event keeps only a clipped copy).
 */
export interface CommandAskDetail {
  deviceId: string;
  deviceName: string;
  mode: "auto" | "sandbox";
  kind: "command" | "write";
  /** The command text (or the tool key of a write). */
  command: string;
  /** A write's target path. */
  path?: string;
  /** The rule that asked, or null for a classifier ask (offers `once` only). */
  rule: string | null;
  reason: string;
}

export interface Approval {
  id: string;
  /** `network`: a device refused a command network hosts; `command`: a command review ask. */
  kind?: "tool" | "network" | "command";
  /** A network ask's detail; null for other approvals. */
  detail?: NetworkApprovalDetail | null;
  /** A command review ask's detail; null for other approvals. */
  command?: CommandAskDetail | null;
  conversationId: string;
  runId: string;
  callId: string;
  toolKey: string;
  /** 来源内的工具原名（连接器工具为连接器里的名字）。 */
  toolName: string;
  connector: { id: string; name: string; slug: string } | null;
  /** An extension tool's plugin and its display name. */
  extension?: { name: string; displayName: { zh: string; en: string } } | null;
  agent: { id: string; name: string };
  input: unknown;
  /** The kernel-rendered summary of the call (Platform operations); null for other tools. */
  summary?: { zh: string; en: string } | null;
  /** The scopes the decider may choose; unset or null: derive from `requestedFor`. */
  scopes?: ApprovalScope[] | null;
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
export const scopesFor = (a: Pick<Approval, "requestedFor" | "scopes">): ApprovalScope[] =>
  a.scopes ? [...a.scopes] : ["once"];

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
  body: {
    decision: "approve" | "deny";
    scope?: ApprovalScope;
    note?: string;
    reason?: string;
    /** A network ask: the checked hosts (absent = all; the unchecked ones count as denied). */
    hosts?: string[];
  },
) =>
  apiFetch<{ approval: Omit<Approval, "toolName" | "connector" | "extension" | "agent"> }>(
    `${base(orgId)}/approvals/${encodeURIComponent(id)}/decision`,
    { method: "POST", body: JSON.stringify(body) },
  );

/**
 * The Platform operation whose approval carries a generated initial password: the account it
 * created, shown once to the person who approved the call (Platform tool spec §14.5 item 2).
 */
export const CREATE_ACCOUNT_OPERATION = "accounts.create";

/**
 * Reads the generated initial password of an approved `accounts.create` call, once: the kernel
 * deletes it as it answers (`account.initial_password_unavailable` afterwards).
 */
export const revealInitialPassword = (orgId: string, approvalId: string) =>
  apiFetch<{ accountId: string; login: string | null; password: string }>(
    `${base(orgId)}/approvals/${encodeURIComponent(approvalId)}/initial-password`,
    { method: "POST" },
  );

export const listToolGrants = (orgId: string) =>
  apiFetch<{ grants: ToolGrant[] }>(`${base(orgId)}/me/tool-grants`);

export const revokeToolGrant = (orgId: string, agentId: string, toolKey: string) =>
  apiFetch<void>(
    `${base(orgId)}/me/tool-grants/${encodeURIComponent(agentId)}/${encodeURIComponent(toolKey)}`,
    { method: "DELETE" },
  );
