/** 组织内角色，由低到高。 */
export const ORG_ROLES = ["guest", "member", "admin", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** `role` 是否不低于 `min`。 */
export function roleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return ORG_ROLES.indexOf(role) >= ORG_ROLES.indexOf(min);
}

/** 组织级动作；路由用 `@OrgAction(action)` 声明所需动作。 */
export type OrgAction =
  | "org.read"
  | "org.update"
  | "org.delete"
  | "org.transfer"
  | "org.members.read"
  | "org.members.manage"
  | "org.invitations.manage"
  | "org.tokens.manage"
  | "org.plugins.manage"
  | "agents.create"
  | "agents.use"
  | "agents.manage"
  | "apps.manage"
  | "apps.use"
  | "approvals.decide"
  | "channels.manage"
  | "skills.read"
  | "skills.manage"
  | "ui.use"
  | "trajectories.read"
  | "evals.manage";

/** 每个动作所需的最低角色。 */
export const ACTION_MIN_ROLE: Record<OrgAction, OrgRole> = {
  "org.read": "guest",
  "org.members.read": "member",
  "org.update": "admin",
  "org.members.manage": "admin",
  "org.invitations.manage": "admin",
  "org.tokens.manage": "admin",
  "org.plugins.manage": "admin",
  "org.delete": "owner",
  "org.transfer": "owner",
  "agents.create": "member",
  "agents.use": "guest",
  // 管理他人的 agent（如离职后重新指派负责人）
  "agents.manage": "admin",
  // 安装 / 配置应用与审阅工具
  "apps.manage": "admin",
  // 读取本人可见的应用、连接自己的凭据（凭据属于具体的人，服务令牌不可用）
  "apps.use": "guest",
  // 能否处理某条审批另由 requested_for / approver_role 判定；审批只能由人处理（服务令牌 / agent 不可）
  "approvals.decide": "guest",
  // 渠道连接（bot 凭据、绑定的 agent、未绑定用户策略）
  "channels.manage": "admin",
  // 组织技能库：成员可查看（给 agent 选技能），管理员上传新技能 / 新版本与删除
  "skills.read": "member",
  "skills.manage": "admin",
  // 插件界面（列出贡献、取视图、执行动作、组织级刷新流）：只给人用，服务令牌不可
  "ui.use": "guest",
  // 轨迹查看器：服务里再判定「组织管理员或该 agent 的负责人」（实时读负责人），其余一律 404
  "trajectories.read": "member",
  // 评测集、用例与评测运行（用例快照即对话内容，只给组织管理员）
  "evals.manage": "admin",
};

/** 服务令牌也可执行的动作：只读的 org.read、org.members.read，以及使用 agent 的 agents.use。 */
const SERVICE_ALLOWED: ReadonlySet<OrgAction> = new Set<OrgAction>([
  "org.read",
  "org.members.read",
  "agents.use",
]);

/** 只允许 user principal 执行的动作：服务令牌即使角色足够也拒绝（除 SERVICE_ALLOWED 外全部）。 */
export const HUMAN_ONLY: ReadonlySet<OrgAction> = new Set<OrgAction>(
  (Object.keys(ACTION_MIN_ROLE) as OrgAction[]).filter((a) => !SERVICE_ALLOWED.has(a)),
);

/** 该角色能否执行该动作。 */
export function can(role: OrgRole, action: OrgAction): boolean {
  return roleAtLeast(role, ACTION_MIN_ROLE[action]);
}
