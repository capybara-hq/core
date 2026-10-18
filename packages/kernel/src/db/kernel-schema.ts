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
}

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
  created_at: Ts;
  deleted_at: TsNullable;
}

export interface MembershipsTable {
  org_id: string;
  account_id: string;
  role: "owner" | "admin" | "member" | "guest";
  created_at: Ts;
  updated_at: Ts;
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
}

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
  status: "queued" | "running" | "completed" | "failed" | "aborted";
  agent_version: number;
  trigger_account_id: string;
  /** 0008：创建运行时最新 user_message 的 seq（终态时 consumed_seq 至少推进到它）。 */
  trigger_seq: Int8;
  created_at: Ts;
  started_at: TsNullable;
  finished_at: TsNullable;
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

/**
 * 内核 schema（capybara）的表结构，逐列对应 0002_secrets.sql（secrets）、0003_identity.sql、
 * 0005_agents.sql、0006_conversations.sql 与 0007_checkpoints.sql。
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
}

export type KernelDb = Kysely<KernelDatabase>;

/** 把无类型的 Kysely 实例收窄成内核 schema 视图（`capybara`）。 */
// biome-ignore lint/suspicious/noExplicitAny: 入口处接收无表结构类型的实例
export function kernelDb(db: Kysely<any>): KernelDb {
  return db.withSchema("capybara") as unknown as KernelDb;
}
