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

/** 内核 schema（capybara）的表结构，逐列对应 0002_secrets.sql（secrets）与 0003_identity.sql。 */
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
}

export type KernelDb = Kysely<KernelDatabase>;

/** 把无类型的 Kysely 实例收窄成内核 schema 视图（`capybara`）。 */
// biome-ignore lint/suspicious/noExplicitAny: 入口处接收无表结构类型的实例
export function kernelDb(db: Kysely<any>): KernelDb {
  return db.withSchema("capybara") as unknown as KernelDb;
}
