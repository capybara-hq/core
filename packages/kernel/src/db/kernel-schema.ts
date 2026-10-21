import type { ColumnType, Generated, Kysely } from "kysely";

/** 带默认值的时间戳列：插入可省略，读出为 Date。 */
type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNullable = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb 列：写入时传 JSON 字符串，读出为已解析对象。 */
type Json<T = Record<string, unknown>> = ColumnType<T, string | undefined, string>;

export interface AccountsTable {
  id: string;
  display_name: string;
  email: string | null;
  email_verified: Generated<boolean>;
  status: Generated<"active" | "disabled">;
  is_enterprise_admin: Generated<boolean>;
  created_at: Ts;
  updated_at: Ts;
}

export interface IdentitiesTable {
  source: string;
  external_id: string;
  account_id: string;
  email: string | null;
  email_verified: Generated<boolean>;
  profile: Json;
  created_at: Ts;
  /** 0019：身份行如何建立（Ruling A18）；null 为旧行，按 `sso` 处理。 */
  linked_via: ColumnType<LinkedVia | null, LinkedVia | null | undefined, LinkedVia | null>;
}

/** 身份行的建立方式：IM 绑定链接、第三方登录、通讯录同步、本地登录名。 */
export type LinkedVia = "bind" | "sso" | "directory" | "local";

export interface LocalPasswordsTable {
  account_id: string;
  password_hash: string;
  updated_at: Ts;
}

export interface OrgsTable {
  id: string;
  slug: string;
  name: string;
  created_by: string | null;
  /** 0010：组织级设置（插入可省略，用列默认值 `{}`；写入传 JSON 字符串）。 */
  settings: Json;
  created_at: Ts;
  deleted_at: TsNullable;
  /** 0021：已删除组织的对象存储清理完成时间（storage/purge.ts）；插入可省略。 */
  storage_purged_at: TsNullable;
  /** 0021：清理任务的认领时间（认领超时后可重新认领）；插入可省略。 */
  storage_purge_claimed_at: TsNullable;
}

export interface MembershipsTable {
  org_id: string;
  account_id: string;
  role: "owner" | "admin" | "member" | "guest";
  created_at: Ts;
  updated_at: Ts;
  /** 0017：成员关系来源；null = 手动 / 邀请，`"directory:<插件名>"` = 通讯录同步加入。 */
  source: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface InvitationsTable {
  id: string;
  org_id: string;
  role: "admin" | "member" | "guest";
  token_hash: string;
  created_by: string;
  created_at: Ts;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  accepted_at: TsNullable;
  accepted_by: string | null;
  revoked_at: TsNullable;
}

export interface SessionsTable {
  id: string;
  account_id: string;
  current_org_id: string | null;
  refresh_hash: string;
  prev_refresh_hash: string | null;
  rotated_at: TsNullable;
  user_agent: string | null;
  ip: string | null;
  created_at: Ts;
  last_used_at: Ts;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: TsNullable;
}

export interface ApiTokensTable {
  id: string;
  kind: "personal" | "service";
  account_id: string | null;
  org_id: string | null;
  role: "admin" | "member" | "guest" | null;
  name: string;
  token_hash: string;
  created_by: string;
  created_at: Ts;
  last_used_at: TsNullable;
  expires_at: TsNullable;
  revoked_at: TsNullable;
}

export interface DeploymentSettingsTable {
  key: string;
  value: ColumnType<unknown, string, string>;
  updated_by: string | null;
  updated_at: Ts;
}

export interface PluginOrgConfigsTable {
  plugin: string;
  org_id: string;
  enabled: Generated<boolean>;
  /** 没有配置时为 null。 */
  config: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  updated_by: string | null;
  updated_at: Ts;
}

export interface AuditEventsTable {
  id: Generated<string>;
  at: Ts;
  actor_account_id: string | null;
  actor_token_id: string | null;
  org_id: string | null;
  action: string;
  target: string | null;
  detail: Json;
}

/** 0016_plugin_permissions.sql：插件已批准的权限快照。 */
export interface PluginPermissionSnapshotsTable {
  plugin: string;
  version: string;
  /** 规范化的权限集合（见 plugins/permission-set.ts）。 */
  permissions: Json<unknown>;
  approved_by: string | null;
  approved_at: Ts;
  source: "cli" | "auto";
}

/** 0002_secrets.sql：加密值（读写走 `createSecrets`，这里只供按键查询是否存在）。 */
export interface SecretsTable {
  namespace: string;
  org_id: string;
  key: string;
  ciphertext: Buffer;
  updated_at: Ts;
}

/** 0005_agents.sql：agent 当前元数据（定义在 agent_versions）。 */
export interface AgentsTable {
  id: string;
  org_id: string;
  owner_account_id: string;
  visibility: "private" | "org" | "members";
  org_role: Generated<"admin" | "member" | "guest">;
  current_version: number;
  needs_reassignment: Generated<boolean>;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/** 0005_agents.sql：agent 定义的版本，只追加。 */
export interface AgentVersionsTable {
  agent_id: string;
  version: number;
  definition: Json;
  created_by: string;
  created_at: Ts;
}

/** 0005_agents.sql：visibility='members' 的 agent 名单。 */
export interface AgentMembersTable {
  agent_id: string;
  account_id: string;
}

/** PG bigint：pg 驱动读出为字符串，读取方自行 `Number()`。 */
type Int8 = ColumnType<string, number | string | undefined, number | string>;

/** 0006_conversations.sql：会话；`last_seq` 为已分配的最大事件序号。 */
export interface ConversationsTable {
  id: string;
  org_id: string;
  agent_id: string;
  account_id: string;
  title: string | null;
  last_seq: Int8;
  consumed_seq: Int8;
  created_at: Ts;
  updated_at: Ts;
  /** 0028：chat（普通对话）/ eval（整轮回放的隐藏对话）。 */
  kind: ColumnType<ConversationKind, ConversationKind | undefined, ConversationKind>;
  /** 0028：eval 对话所属的评测运行。 */
  eval_run_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export type ConversationKind = "chat" | "eval";

/** 0006_conversations.sql：会话事件日志，只追加。 */
export interface ConversationEventsTable {
  conversation_id: string;
  seq: Int8;
  type: string;
  run_id: string | null;
  idem_key: string | null;
  payload: Json<unknown>;
  created_at: Ts;
}

/** 0006_conversations.sql：一次 agent 运行。 */
export interface RunsTable {
  id: string;
  conversation_id: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted";
  agent_version: number;
  trigger_account_id: string;
  /** 0008：创建运行时最新 user_message 的 seq（终态时 consumed_seq 至少推进到它）。 */
  trigger_seq: Int8;
  created_at: Ts;
  started_at: TsNullable;
  finished_at: TsNullable;
  /** 0012：进入 waiting 的时刻（续跑时清空）。 */
  waiting_since: TsNullable;
  /** 0012：累计等待时长（毫秒），不计入运行时长。 */
  waited_ms: Int8;
  /** 0012：续跑任务的 jobId；为空表示按触发消息生成的 jobId。 */
  job_id: string | null;
  /** 0012：最近一次（续跑）回到 queued 的时刻。 */
  queued_at: TsNullable;
}

/** 0010_tools.sql：已安装的应用（连接器实例）。 */
export interface AppsTable {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  /** 连接器 kind（`Connector.kind`，如 `mcp`），由 `ToolRegistry.connector(kind)` 查找实现。 */
  connector: string;
  /** jsonb 带默认值：Json 的插入类型本身已可省略，不再包 Generated（嵌套会让插入类型失配）。 */
  endpoint: Json<unknown>;
  /** `{type, ownership: "org" | "personal", ...非密钥字段}`；凭据在 secrets。 */
  auth: Json<unknown>;
  status: Generated<"active" | "disabled">;
  created_by: string;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
  /** 0015：最近一次成功拿到工具清单的时间；为空 = 从未拍过快照（首个快照按安装处理）。 */
  tools_synced_at: TsNullable;
}

/** 0010_tools.sql：应用暴露的工具。 */
export interface AppToolsTable {
  app_id: string;
  name: string;
  spec: Json<unknown>;
  spec_hash: string;
  status: "enabled" | "disabled" | "pending_review";
  default_policy: "allow" | "ask" | "deny";
  reviewed_at: TsNullable;
  /** 0013：工具来源（`resources` = 内核为支持 resources 的应用补上的两个工具）。 */
  source: Generated<"connector" | "resources">;
  /** 0015：变化后待复核的新定义（复核前 spec / spec_hash / source 仍是旧的）。 */
  pending_spec: ColumnType<unknown, string | null | undefined, string | null>;
  pending_spec_hash: string | null;
  pending_source: "connector" | "resources" | null;
  /** 0015：默认策略的来历（admin = 管理员设定，复核通过后保留；derived = 按注解重新推导）。 */
  policy_source: Generated<"derived" | "admin">;
  /** 0015：远端不再提供该工具的时间（工具停用，行保留）。 */
  missing_since: TsNullable;
}

/** 0010_tools.sql：「以后都允许」。 */
export interface ToolGrantsTable {
  org_id: string;
  account_id: string;
  agent_id: string;
  tool_key: string;
  spec_hash: string;
  /** 应用工具的来源应用（插件 / 内置工具为 null）；授权只对同一个应用有效。 */
  app_id: string | null;
  created_at: Ts;
}

/** 0010_tools.sql：「本会话都允许」。 */
export interface ConversationToolGrantsTable {
  conversation_id: string;
  tool_key: string;
  spec_hash: string;
  /** 同 `ToolGrantsTable.app_id`。 */
  app_id: string | null;
}

/** 0010_tools.sql：工具调用审批；requested_for 与 approver_role 至少一个非空。 */
export interface ApprovalsTable {
  id: string;
  org_id: string;
  conversation_id: string;
  run_id: string;
  call_id: string;
  tool_key: string;
  /** jsonb 带默认值：Json 的插入类型本身已可省略。 */
  input: Json<unknown>;
  requested_for: string | null;
  approver_role: string | null;
  status: Generated<"pending" | "approved" | "denied" | "expired" | "cancelled">;
  scope: "once" | "session" | "always" | null;
  decided_by: string | null;
  decided_at: TsNullable;
  expires_at: Date | string;
  created_at: Ts;
  /** 0011：所批准的工具定义指纹（写授权用）。 */
  spec_hash: string;
  /** 0011：应用工具的来源应用。 */
  app_id: string | null;
  /** 0012：同一调用的第几次审批（从 1 起；工具定义变化后重新审批时递增）。 */
  attempt: Generated<number>;
}

/** 0010_tools.sql：ask_user 提问。 */
export interface QuestionsTable {
  id: string;
  org_id: string;
  conversation_id: string;
  run_id: string;
  call_id: string;
  spec: Json<unknown>;
  status: Generated<"pending" | "answered" | "expired" | "cancelled">;
  answer: ColumnType<unknown, string | null | undefined, string | null>;
  answered_by: string | null;
  answered_at: TsNullable;
  expires_at: Date | string;
  created_at: Ts;
  /** 0012：同一调用的第几轮输入请求（从 1 起）。 */
  attempt: Generated<number>;
}

/** 0010_tools.sql：超大工具输出的存档。 */
export interface ToolOutputsTable {
  id: string;
  org_id: string;
  conversation_id: string;
  call_id: string;
  size_chars: number;
  line_count: number;
  content: string;
  created_at: Ts;
  expires_at: Date | string;
}

/** 0014_tool_specs.sql：工具定义快照（内容寻址，只增不改）。 */
export interface ToolSpecsTable {
  spec_hash: string;
  spec: Json<unknown>;
  created_at: Ts;
}

/** bytea 列：读出为 Buffer，写入可传 Buffer / Uint8Array。 */
type Bytea = ColumnType<Buffer, Buffer | Uint8Array, Buffer | Uint8Array>;

/** 0007_checkpoints.sql：LangGraph checkpoint（KyselyCheckpointSaver）。 */
export interface LgCheckpointsTable {
  thread_id: string;
  checkpoint_ns: Generated<string>;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_type: string;
  checkpoint: Bytea;
  metadata_type: string;
  metadata: Bytea;
  created_at: Ts;
}

/** 0007_checkpoints.sql：checkpoint 的 pending writes。 */
export interface LgCheckpointWritesTable {
  thread_id: string;
  checkpoint_ns: Generated<string>;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  value_type: string;
  value: Bytea;
  task_path: Generated<string>;
}

/** 0018_channels.sql：组织的渠道连接（非密钥配置；密钥在 secrets `channels:<id>:config`）。 */
export interface ChannelConnectionsTable {
  id: string;
  org_id: string;
  plugin: string;
  name: string;
  agent_id: string;
  config: Json;
  unbound_policy: Generated<"bind" | "anonymous">;
  status: Generated<"active" | "disabled" | "error">;
  last_error: string | null;
  bot_user_id: string | null;
  tenant_id: string | null;
  created_by: string;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/** 0018_channels.sql：IM 话题 ↔ 会话（未归档的行在 (连接, chat, thread_key, 账号) 上唯一）。 */
export interface ChannelThreadsTable {
  id: string;
  connection_id: string;
  chat_id: string;
  thread_key: string;
  account_id: string | null;
  conversation_id: string;
  created_at: Ts;
  archived_at: TsNullable;
}

/** 0018_channels.sql：会话的 IM 投递目标与已投递到的事件序号（Task 11）。 */
export interface ChannelDeliveriesTable {
  conversation_id: string;
  connection_id: string;
  target: Json<unknown>;
  last_seq: Int8;
  draft_message_id: string | null;
  fail_seq: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  fail_count: Generated<number>;
  updated_at: Ts;
}

/** 0018_channels.sql：出站投递发出的审批 / 提问卡片对应的 IM 消息（Task 11，用于更新卡片状态）。 */
export interface ChannelCardMessagesTable {
  conversation_id: string;
  connection_id: string;
  card_kind: "approval" | "question";
  card_id: string;
  message_id: string;
  target: Json<unknown>;
  created_at: Ts;
}

/** 0018_channels.sql：每个组织一个的匿名访客账号。 */
export interface OrgAnonymousAccountsTable {
  org_id: string;
  account_id: string;
  created_at: Ts;
}

/** 0019：通讯录排除（Ruling A20）——手动移出 / 离开的通讯录成员，同步不再加回。 */
export interface DirectoryExclusionsTable {
  org_id: string;
  account_id: string;
  plugin: string;
  created_at: Ts;
  created_by: string | null;
}

/** 0022_attachments.sql：对话附件（字节在对象存储，见 conversations/attachments.service.ts）。 */
export interface AttachmentsTable {
  id: string;
  org_id: string;
  conversation_id: string | null;
  account_id: string;
  name: string;
  content_type: string;
  size: Int8;
  object_key: string;
  status: "pending" | "ready" | "deleting";
  etag: string | null;
  pages: number | null;
  created_at: Ts;
  expires_at: TsNullable;
  /** 0024：上传用途（技能包不能绑定到消息）。 */
  purpose: ColumnType<AttachmentPurpose, AttachmentPurpose | undefined, AttachmentPurpose>;
}

/** 预签名上传的用途：对话附件 / 技能包 zip。 */
export type AttachmentPurpose = "chat" | "skill-package";

/** 技能版本的清单（`skill_versions.manifest`）。 */
export interface SkillManifest {
  name: string;
  description: string;
  files: { path: string; size: number; sha256: string }[];
}

/** 0024_skills.sql：技能（组织技能库 / agent 自己的技能）。 */
export interface SkillsTable {
  id: string;
  org_id: string;
  scope: "org" | "agent";
  agent_id: string | null;
  name: string;
  description: string;
  current_version: number;
  created_by: string;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/** 0024_skills.sql：技能的版本。 */
export interface SkillVersionsTable {
  skill_id: string;
  version: number;
  manifest: Json<SkillManifest>;
  object_prefix: string;
  created_by: string;
  created_at: Ts;
}

/** 0026_skill_changes.sql：技能变更申请里提议的版本。 */
export interface ProposedSkillVersion {
  /** 已有技能的 id，或新技能预先分配的 id。 */
  skillId: string;
  /** 批准后预期的版本号（试用时目录里用它）。 */
  version: number;
  manifest: SkillManifest;
}

/** 0026_skill_changes.sql：共享 agent 的技能变更申请（R4）。 */
export interface SkillChangeRequestsTable {
  id: string;
  org_id: string;
  agent_id: string;
  skill_id: string | null;
  proposed_version: Json<ProposedSkillVersion>;
  object_prefix: string;
  requested_by_account: string;
  requested_in_conversation: string;
  status: Generated<"pending" | "approved" | "rejected" | "cancelled">;
  decided_by: string | null;
  decided_at: TsNullable;
  created_at: Ts;
}

/** 0023_sandboxes.sql：按对话的沙箱（见 sandbox/sandbox.service.ts）。 */
export interface SandboxesTable {
  conversation_id: string;
  org_id: string;
  provider: string;
  /** 提供方的 `SandboxHandle`；creating 时为 NULL。 */
  handle: ColumnType<
    { id: string; [k: string]: unknown } | null,
    string | null | undefined,
    string | null
  >;
  status: "creating" | "running" | "suspended" | "destroyed";
  last_used_at: Ts;
  running_since: TsNullable;
  created_at: Ts;
  suspended_at: TsNullable;
  destroyed_at: TsNullable;
  /** 防护号：锁内的每次 status / handle 写入都按它比较并加一。 */
  generation: ColumnType<number, number | undefined, number>;
  /** 曾经成功创建过实例（只会置 true）。 */
  had_instance: ColumnType<boolean, boolean | undefined, boolean>;
  /** 换提供方时留下的旧实例。 */
  prev_provider: string | null;
  prev_handle: ColumnType<
    { id: string; [k: string]: unknown } | null,
    string | null | undefined,
    string | null
  >;
  sweep_failed_at: TsNullable;
}

/** pg numeric：驱动读出为字符串（精确小数），读取方自行 `Number()`。 */
type Numeric = ColumnType<string, number | string, number | string>;
type NumericNullable = ColumnType<string | null, number | string | null, number | string | null>;

/** 0027_model_prices.sql：模型价格（每百万 token，币种为部署设置 priceCurrency）。 */
export interface ModelPricesTable {
  provider: string;
  model: string;
  input_per_mtok: Numeric;
  output_per_mtok: Numeric;
  cache_read_per_mtok: NumericNullable;
  cache_write_per_mtok: NumericNullable;
  updated_by: string | null;
  updated_at: Ts;
}

/** 0028_evals.sql：评测集（一个集合对应一个 agent；软删除）。 */
export interface EvalSetsTable {
  id: Generated<string>;
  org_id: string;
  agent_id: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  rubric: string | null;
  created_by: string;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/** 0028_evals.sql：评测用例（某次运行的日志快照，不引用原对话）。 */
export interface EvalCasesTable {
  id: Generated<string>;
  set_id: string;
  org_id: string;
  source_conversation_id: string;
  source_run_id: string;
  agent_version: number;
  title: string;
  snapshot: Json<unknown>;
  snapshot_bytes: number;
  replayable_steps: ColumnType<number, number | undefined, number>;
  added_by: string;
  created_at: Ts;
}

export type EvalRunStatus = "queued" | "running" | "completed" | "cancelled" | "capped" | "failed";

/** 0028_evals.sql：评测运行（T4 起写入）。 */
export interface EvalRunsTable {
  id: Generated<string>;
  org_id: string;
  set_id: string;
  mode: "step" | "run";
  candidate: Json<unknown>;
  judge: ColumnType<boolean, boolean | undefined, boolean>;
  token_cap: Int8;
  tokens_used: Int8;
  status: ColumnType<EvalRunStatus, EvalRunStatus | undefined, EvalRunStatus>;
  cases_total: number;
  cases_done: ColumnType<number, number | undefined, number>;
  estimate: Json<unknown>;
  created_by: string;
  created_at: Ts;
  started_at: TsNullable;
  finished_at: TsNullable;
}

export type EvalResultStatus = "pending" | "running" | "done" | "error" | "skipped";

/** 0028_evals.sql：评测结果（每用例一行或每步一行，T4 起写入）。 */
export interface EvalResultsTable {
  id: Generated<string>;
  run_id: string;
  case_id: string;
  org_id: string;
  step: number | null;
  model_call_seq: ColumnType<
    string | null,
    number | string | null | undefined,
    number | string | null
  >;
  status: ColumnType<EvalResultStatus, EvalResultStatus | undefined, EvalResultStatus>;
  baseline: ColumnType<unknown | null, string | null | undefined, string | null>;
  candidate: ColumnType<unknown | null, string | null | undefined, string | null>;
  diff: ColumnType<unknown | null, string | null | undefined, string | null>;
  judge: ColumnType<unknown | null, string | null | undefined, string | null>;
  drift: ColumnType<string[], string[] | undefined, string[]>;
  error: ColumnType<unknown | null, string | null | undefined, string | null>;
  eval_conversation_id: string | null;
  label: "pass" | "fail" | null;
  label_note: string | null;
  labeled_by: string | null;
  labeled_at: TsNullable;
  created_at: Ts;
  updated_at: Ts;
}

/**
 * 内核 schema（capybara）的表结构，逐列对应 0002_secrets.sql（secrets）、0003_identity.sql、
 * 0005_agents.sql、0006_conversations.sql、0007_checkpoints.sql、0010_tools.sql、0011_approvals_spec.sql、0016_plugin_permissions.sql、0018_channels.sql 与 0019_identity_trust.sql。
 */
export interface KernelDatabase {
  accounts: AccountsTable;
  identities: IdentitiesTable;
  local_passwords: LocalPasswordsTable;
  orgs: OrgsTable;
  memberships: MembershipsTable;
  invitations: InvitationsTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  deployment_settings: DeploymentSettingsTable;
  plugin_org_configs: PluginOrgConfigsTable;
  audit_events: AuditEventsTable;
  secrets: SecretsTable;
  agents: AgentsTable;
  agent_versions: AgentVersionsTable;
  agent_members: AgentMembersTable;
  conversations: ConversationsTable;
  conversation_events: ConversationEventsTable;
  runs: RunsTable;
  lg_checkpoints: LgCheckpointsTable;
  lg_checkpoint_writes: LgCheckpointWritesTable;
  apps: AppsTable;
  app_tools: AppToolsTable;
  tool_grants: ToolGrantsTable;
  conversation_tool_grants: ConversationToolGrantsTable;
  approvals: ApprovalsTable;
  questions: QuestionsTable;
  tool_outputs: ToolOutputsTable;
  tool_specs: ToolSpecsTable;
  plugin_permission_snapshots: PluginPermissionSnapshotsTable;
  channel_connections: ChannelConnectionsTable;
  channel_threads: ChannelThreadsTable;
  channel_deliveries: ChannelDeliveriesTable;
  channel_card_messages: ChannelCardMessagesTable;
  org_anonymous_accounts: OrgAnonymousAccountsTable;
  directory_exclusions: DirectoryExclusionsTable;
  attachments: AttachmentsTable;
  sandboxes: SandboxesTable;
  skills: SkillsTable;
  skill_versions: SkillVersionsTable;
  skill_change_requests: SkillChangeRequestsTable;
  model_prices: ModelPricesTable;
  eval_sets: EvalSetsTable;
  eval_cases: EvalCasesTable;
  eval_runs: EvalRunsTable;
  eval_results: EvalResultsTable;
}

export type KernelDb = Kysely<KernelDatabase>;

/** 把无类型的 Kysely 实例收窄成内核 schema 视图（`capybara`）。 */
// biome-ignore lint/suspicious/noExplicitAny: 入口处接收无表结构类型的实例
export function kernelDb(db: Kysely<any>): KernelDb {
  return db.withSchema("capybara") as unknown as KernelDb;
}
