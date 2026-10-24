import { apiFetch } from "./api";

/** 组织内角色，由低到高（与内核 `orgs/roles.ts` 一致）。 */
export const ORG_ROLES = ["guest", "member", "admin", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** 可邀请的角色（owner 只能经转让获得）。 */
export const INVITABLE_ROLES = ["guest", "member", "admin"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** 邀请有效期的可选项（小时）：1 天、7 天（内核默认）、30 天（内核上限）。 */
export const INVITATION_HOURS = [24, 168, 720] as const;
export const DEFAULT_INVITATION_HOURS = 168;

/** `GET /api/v1/orgs/:orgId/members` 的一项。 */
export interface Member {
  account: { id: string; displayName: string; email: string | null };
  role: OrgRole;
  joinedAt: string;
  /** 该组织的匿名访客（渠道连接的匿名策略用）：不能改角色、移出或转让所有权。 */
  anonymous: boolean;
}

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export interface Invitation {
  id: string;
  orgId: string;
  role: InvitableRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: InvitationStatus;
}

/** 凭令牌的公开预览。 */
export interface InvitationPreview {
  org: { id: string; name: string };
  role: InvitableRole;
  expiresAt: string;
}

export interface SignupInput {
  login: string;
  password: string;
  displayName: string;
}

const org = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const listMembers = (orgId: string) =>
  apiFetch<{ members: Member[] }>(`${org(orgId)}/members`);

export const changeMemberRole = (orgId: string, accountId: string, role: OrgRole) =>
  apiFetch<{ accountId: string; role: OrgRole }>(
    `${org(orgId)}/members/${encodeURIComponent(accountId)}`,
    json("PATCH", { role }),
  );

/** 移出成员（内核走离职处理：吊销会话与令牌、转交其资源等）。 */
export const removeMember = (orgId: string, accountId: string) =>
  apiFetch<void>(`${org(orgId)}/members/${encodeURIComponent(accountId)}`, { method: "DELETE" });

/** 转让所有权：对方成为 owner，自己降为 admin。 */
export const transferOwnership = (orgId: string, toAccountId: string) =>
  apiFetch<void>(`${org(orgId)}/transfer`, json("POST", { toAccountId }));

export const listInvitations = (orgId: string) =>
  apiFetch<{ invitations: Invitation[] }>(`${org(orgId)}/invitations`);

/** 创建邀请；令牌只在这次响应里返回。 */
export const createInvitation = (
  orgId: string,
  input: { role: InvitableRole; expiresInHours: number },
) =>
  apiFetch<{ invitation: Omit<Invitation, "status">; token: string }>(
    `${org(orgId)}/invitations`,
    json("POST", input),
  );

export const revokeInvitation = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });

export const previewInvitation = (token: string) =>
  apiFetch<InvitationPreview>(`/api/v1/invitations/${encodeURIComponent(token)}`);

/** 接受邀请：已登录时不带 body；未登录时带注册信息（成功后内核设会话 Cookie）。 */
export const acceptInvitation = (token: string, signup?: SignupInput) =>
  apiFetch<{ account: { id: string }; orgId: string; role: OrgRole }>(
    `/api/v1/invitations/${encodeURIComponent(token)}/accept`,
    json("POST", signup ?? {}),
  );

/** 接受页的站内路径（不含语言前缀）。 */
export const invitePath = (token: string) => `/invite/${encodeURIComponent(token)}`;

/** 发给对方的完整链接（带语言前缀）。 */
export const inviteUrl = (origin: string, locale: string, token: string) =>
  `${origin}/${locale}${invitePath(token)}`;

/** 当前组织里自己的角色（界面用；最终由内核判定）。 */
export function myRole(me: {
  currentOrgId: string | null;
  memberships: { orgId: string; role: string }[];
}): OrgRole | undefined {
  const role = me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;
  return (ORG_ROLES as readonly string[]).includes(role ?? "") ? (role as OrgRole) : undefined;
}

/** `role` 是否不低于 `min`。 */
export const roleAtLeast = (role: OrgRole | undefined, min: OrgRole): boolean =>
  role !== undefined && ORG_ROLES.indexOf(role) >= ORG_ROLES.indexOf(min);
