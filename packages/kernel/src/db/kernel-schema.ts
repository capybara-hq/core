import type {
  ConversationSource,
  FileSystemHandle,
  GitHostEntry,
  ParsedTheme,
  SandboxTier,
  SkillInvocation,
} from "@capybara-hq/plugin-sdk";
import type { ColumnType, Generated, Kysely } from "kysely";
import type { ModelRef } from "../agents/definition.js";
import type {
  ScheduleChat,
  ScheduleMarker,
  ScheduleMode,
  SchedulePauseReason,
  ScheduleStatus,
  ScheduleTrigger,
  TaskRunSkipReason,
  TaskRunStatus,
} from "../schedules/types.js";

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
  is_super_admin: Generated<boolean>;
  created_at: Ts;
  updated_at: Ts;
  /** 0064: the org the account last chose as current; a new session starts in it. */
  last_org_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0091: the person's time zone (IANA); null follows the browser (run context spec §3.4). */
  time_zone: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0090: the account must set its own password first (a generated initial password). */
  must_change_password: Generated<boolean>;
  /** 0093: the person's theme id across all their orgs; null follows the org (themes spec §7). */
  theme: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * 0090: a generated initial password sealed for the person who approved the account's creation,
 * read once on the web (Platform tool spec §14.5 item 2).
 */
export interface AccountInitialPasswordsTable {
  account_id: string;
  recipient_account_id: string;
  conversation_id: string;
  run_id: string;
  call_id: string;
  master_key_id: string;
  ciphertext: Buffer;
  expires_at: Date | string;
  created_at: Ts;
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

export interface ExtensionOrgConfigsTable {
  plugin: string;
  org_id: string;
  enabled: Generated<boolean>;
  /** null when there is no config. */
  config: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  updated_by: string | null;
  updated_at: Ts;
}

/** An org's copy of an extension's overridable deployment config fields (0086, spec A §5.4). */
export interface ExtensionOrgOverridesTable {
  plugin: string;
  org_id: string;
  /** The copy's non-secret values (its secrets are in `secrets`). */
  config: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_by: string | null;
  created_at: Ts;
  updated_by: string | null;
  updated_at: Ts;
}

/** An org admin's switch of one extension tool (0086, spec A §7). */
export interface OrgToolSwitchesTable {
  org_id: string;
  plugin: string;
  tool: string;
  enabled: boolean;
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

/** 0016, renamed in 0041: the approved permission snapshot of an extension. */
export interface ExtensionPermissionSnapshotsTable {
  plugin: string;
  version: string;
  /** The normalized permission set (see extensions/permission-set.ts). */
  permissions: Json<unknown>;
  approved_by: string | null;
  approved_at: Ts;
  /** `bootstrap` (0050): approved by the bootstrap step (core's release vouched for it). */
  source: "cli" | "auto" | "web" | "bootstrap";
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
  /** 0067: the profile (display data, outside the versions). */
  profile_avatar: ColumnType<
    Record<string, unknown> | null,
    string | null | undefined,
    string | null
  >;
  profile_description: Generated<string>;
  profile_quick_actions: ColumnType<unknown[], string | undefined, string>;
  profile_updated_at: Ts;
  /** 0085: the template the agent was created from (display only, no FK). */
  created_from_template_id: NullableCol<string>;
  created_from_template_version: NullableCol<number>;
  created_from_template_name: NullableCol<string>;
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
  /** 0053: a sub-agent's parent conversation (kind 'subagent' only). */
  parent_conversation_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0053: the sub-agent type as resolved at the first dispatch (kind 'subagent' only). */
  subagent_type: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0057: who wrote `title` (null = nobody yet). */
  title_source: ColumnType<TitleSource | null, TitleSource | null | undefined, TitleSource | null>;
  /** 0057: title-generation attempts made. */
  title_attempts: ColumnType<number, number | undefined, number>;
  /** 0057: the first message's clientMessageId (idempotent create on first send). */
  create_request_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0058: the switched model / effort (`Selection`); null = never switched. */
  selection: ColumnType<unknown | null, string | null | undefined, string | null>;
  /** 0059: a run failed or was stopped with messages queued; the queue waits for resume. */
  queue_paused: ColumnType<boolean, boolean | undefined, boolean>;
  /** 0062: why the queue paused (`QueuePauseReason`); null when not paused or not recorded. */
  queue_pause_reason: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0065: when the owner archived it (hidden from the default lists); null = not archived. */
  archived_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** 0065: when the owner deleted it (soft delete: hidden everywhere for the owner); null = live. */
  deleted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** 0074: levels below the root conversation (0 = a root; a sub-agent's is its parent's + 1). */
  subagent_depth: ColumnType<number, number | undefined, number>;
  /** 0088, renamed in 0105: the device the conversation runs in; null = not chosen yet. */
  device_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0113: the scheduled task that created it (`new` mode); null otherwise. */
  scheduled_task_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * 0124: where the conversation comes from, set at creation and never changed. Required on insert
   * (the column's `web` default is not relied on: a forgotten source must not read as web).
   */
  source: ColumnType<ConversationSource, ConversationSource, never>;
  /**
   * 0125: when a person stopped this root conversation and its sub-agent tree; cleared when the
   * root next starts a run. While set the tree's wakes are held (agent map spec §6).
   */
  tree_stopped_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** 0060: an org's order of file-preview@1 previewers (UI refresh B Task 11). */
export interface FilePreviewersTable {
  org_id: string;
  plugin: string;
  previewer_id: string;
  position: number;
  disabled: ColumnType<boolean, boolean | undefined, boolean>;
}

/** 0073: an org's default provider of an `org-default` extension point. */
export interface OrgExtensionPointDefaultsTable {
  org_id: string;
  /** The extension point name without the major (`web-search`). */
  point: string;
  extension: string;
  updated_at: Ts;
  updated_by: string | null;
}

/** 0059: a queued message (not in the event log until sent). */
export interface ConversationQueueTable {
  id: string;
  conversation_id: string;
  account_id: string;
  position: Int8;
  text: string;
  /** The content blocks after the text (`@` resources, uploaded file refs). */
  content: Json<unknown>;
  /** `@` resource metadata for `user_message.payload.attachments`. */
  attachments: ColumnType<unknown, string | undefined, string>;
  /** Uploaded files' display metadata `{ attachmentId, name, mediaType }[]`. */
  files: ColumnType<unknown, string | undefined, string>;
  client_message_id: string;
  /** The model the message picks (`{ provider, model }`), or null (0061). */
  model: ColumnType<unknown, string | null | undefined, string | null>;
  /** The effort the message picks, or null (0061). */
  effort: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0062: the `user_message.skill` record of a queued skill invocation, or null. */
  skill: ColumnType<unknown, string | null | undefined, string | null>;
  /**
   * 0113: the schedule marker of a scheduled task's message, plus the task's zone (`timeZone`, the
   * message's zone override; not copied into the logged marker); null for a person's message.
   */
  schedule: ColumnType<
    (ScheduleMarker & { timeZone?: string }) | null,
    string | null | undefined,
    string | null
  >;
  created_at: Ts;
  updated_at: Ts;
}

export type TitleSource = "generated" | "manual";

/** chat; eval (a hidden full-run replay conversation); subagent (0053: a sub-agent's conversation). */
export type ConversationKind = "chat" | "eval" | "subagent";

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
  /**
   * 0012: the run's job id when it is not the trigger's `runJobId`: a resume's
   * (`resumeJobId`), or `<runJobId>-<n>` for a later run of the same trigger (R34); null: the
   * trigger's first run, under `runJobId`.
   */
  job_id: string | null;
  /** 0012：最近一次（续跑）回到 queued 的时刻。 */
  queued_at: TsNullable;
  /** 0053: tokens used by this run's sub-agents (the parent run's budget counter). */
  subagent_tokens_used: Int8;
  /** 0054: when this run's `subagents` wait expires (set while it waits on sub-agents). */
  wait_expires_at: TsNullable;
  /**
   * 0074: the person-triggered root run whose budget window this run counts against (dispatches
   * and its descendants' tokens, agent map spec §6); null = the run is its own budget run.
   */
  budget_run_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * 0113: the scheduled task run this run serves (set on the run the task's message triggers and
   * inherited by its unattended descendants); null = a person's run.
   */
  scheduled_task_run_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** 0053: one row per sub-agent dispatch (an `Agent` call of a parent run). */
export interface SubagentDispatchesTable {
  parent_run_id: string;
  parent_call_id: string;
  parent_conversation_id: string;
  step: number;
  child_conversation_id: string;
  child_run_id: string;
  /** A follow-up to an existing sub-agent, not a new one. */
  resumed: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Ts;
  /** 0074: the budget run the dispatch counts against (`runs.budget_run_id` of the tree). */
  budget_run_id: string;
  /** 0074: the dispatch of a `context: fork` skill invocation (phase D). */
  for_skill: ColumnType<boolean, boolean | undefined, boolean>;
}

/** 0053: an agent template installed in an org from a plugin. */
export interface AgentTemplatesTable {
  id: string;
  /** 0084: the owner shares this template with other orgs. */
  shareable: Dflt<boolean>;
  org_id: string;
  name: string;
  catalog_item_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** The plugin that installed it: the roster type is `<plugin>:<name>`; null (0081, nullable) = the bare `<name>`. */
  plugin_name: ColumnType<string | null, string | null | undefined, string | null>;
  current_version: number;
  deleted_at: TsNullable;
  created_at: Ts;
  updated_at: Ts;
  /** 0081: the platform template this copy links to (null = none). */
  platform_template_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0081: a pin keeps the copy on its own stored version (ruling B2). */
  pinned_version: ColumnType<number | null, number | null | undefined, number | null>;
}

/** 0053: one version of an agent template; `definition` is the parsed frontmatter and body. */
export interface AgentTemplateVersionsTable {
  template_id: string;
  version: number;
  definition: Json<unknown>;
  source_format: ColumnType<SourceFormat, SourceFormat | undefined, SourceFormat>;
  catalog_version: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
}

/**
 * 0010_tools.sql（0033 由 `apps` 改名）：已安装的连接器（远端服务实例）。列 `connector` 是连接器插件的 kind，
 * 改名后叫 `connectors.connector` 有点别扭，但为避免多一次 RENAME 保持原名。
 */
export interface ConnectorsTable {
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
  /**
   * 0037, renamed in 0042: the source item (an app's template records the app item) and version
   * when installed from a catalog template.
   */
  catalog_item_id: ColumnType<string | null, string | null | undefined, string | null>;
  catalog_version: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0037：模板的 defaultToolPolicies（授权码连接器在首个快照时应用）。 */
  template_tool_policies: ColumnType<
    Record<string, "allow" | "ask" | "deny"> | null,
    string | null | undefined,
    string | null
  >;
  /** 0081: the platform connector template this connector was made from (null = none). */
  platform_template_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * 0106: the setup guide of its connector template it was last set up with (`{ guideId, version,
   * hash, mode: null }`); null when unknown (custom connectors, connectors before 0106).
   */
  guide_ack: ColumnType<GuideAckJson | null, string | null | undefined, string | null>;
  /** 0126: the git hosts this connector declares (null: none). */
  git_hosts: ColumnType<GitHostEntry[] | null, string | null | undefined, string | null>;
  /** 0126: an org-owned connector serves as a git gateway source (personal ones always do). */
  use_for_git: Generated<boolean>;
  /** 0127: the org's policy for pushes through this connector (virtual tool `git_push`). */
  git_push_policy: Generated<"allow" | "ask" | "deny">;
}

/**
 * 0104: a member's own policy for one tool of a personal-credential connector, for calls made with
 * their own connection (maintainer decision 2026-11-09).
 */
export interface ConnectorToolAccountPoliciesTable {
  org_id: string;
  connector_id: string;
  account_id: string;
  tool_name: string;
  policy: "allow" | "ask" | "deny";
  updated_at: Ts;
}

/** 0010_tools.sql（0033 由 `app_tools` 改名）：连接器暴露的工具。 */
export interface ConnectorToolsTable {
  connector_id: string;
  name: string;
  spec: Json<unknown>;
  spec_hash: string;
  status: "enabled" | "disabled" | "pending_review";
  default_policy: "allow" | "ask" | "deny";
  reviewed_at: TsNullable;
  /** 0013：工具来源（`resources` = 内核为支持 resources 的连接器补上的两个工具）。 */
  source: Generated<"connector" | "resources">;
  /** 0015：变化后待复核的新定义（复核前 spec / spec_hash / source 仍是旧的）。 */
  pending_spec: ColumnType<unknown, string | null | undefined, string | null>;
  pending_spec_hash: string | null;
  pending_source: "connector" | "resources" | null;
  /** 0015：默认策略的来历（admin = 管理员设定，复核通过后保留；derived = 按注解重新推导）。 */
  policy_source: Generated<"derived" | "admin" | "template">;
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
  /** 连接器工具的来源连接器（插件 / 内置工具为 null；0033 由 `app_id` 改名）；授权只对同一个连接器有效。 */
  connector_id: string | null;
  created_at: Ts;
}

/** 0010_tools.sql：「本会话都允许」。 */
export interface ConversationToolGrantsTable {
  conversation_id: string;
  tool_key: string;
  spec_hash: string;
  /** 同 `ToolGrantsTable.connector_id`。 */
  connector_id: string | null;
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
  status: Generated<"pending" | "approved" | "denied" | "expired" | "cancelled" | "skipped">;
  scope: "once" | "session" | "always" | null;
  decided_by: string | null;
  decided_at: TsNullable;
  expires_at: Date | string;
  created_at: Ts;
  /** 0011：所批准的工具定义指纹（写授权用）。 */
  spec_hash: string;
  /** 0011：连接器工具的来源连接器（0033 由 `app_id` 改名）。 */
  connector_id: string | null;
  /** 0012：同一调用的第几次审批（从 1 起；工具定义变化后重新审批时递增）。 */
  attempt: Generated<number>;
  /** 0056: the reason given with a denial (null without one). */
  deny_reason: Generated<string | null>;
  /** 0086: the kernel-rendered summary of the call (per-call policies; null without one). */
  summary: ColumnType<{ zh: string; en: string } | null, string | null | undefined, string | null>;
  /** 0086: the scopes the person may choose (null: derived, see `approvals.service.ts`). */
  scopes: ColumnType<
    ("once" | "session" | "always")[] | null,
    ("once" | "session" | "always")[] | null | undefined,
    ("once" | "session" | "always")[] | null
  >;
  /**
   * 0114: what is asked: a tool call ('tool') or a refused network domain ('network'); 0126: a
   * git push the gateway held ('git').
   */
  kind: Generated<"tool" | "network" | "git">;
  /** 0114: a network or git ask's facts, kept result and outcome (null for tool approvals). */
  detail: ColumnType<unknown | null, string | null | undefined, string | null>;
}

/** 0010_tools.sql：AskUserQuestion 提问。 */
export interface QuestionsTable {
  id: string;
  org_id: string;
  conversation_id: string;
  run_id: string;
  call_id: string;
  spec: Json<unknown>;
  status: Generated<"pending" | "answered" | "skipped" | "expired" | "cancelled">;
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
/**
 * `channel_connections.guide_ack` (0099) and `connectors.guide_ack` (0106): the setup guide a
 * target was set up with; `hash` is the v2 drift hash (`setupGuideHash`, admin audience) of
 * `mode` (null for a place without modes).
 */
export interface GuideAckJson {
  guideId: string;
  version: string;
  hash: string;
  mode: string | null;
}

export interface ChannelConnectionsTable {
  id: string;
  org_id: string;
  plugin: string;
  name: string;
  agent_id: string;
  config: Json;
  unbound_policy: Generated<"bind" | "anonymous">;
  status: Generated<"active" | "disabled" | "error">;
  /** 0038_channel_inbound_mode.sql: how inbound events arrive (long connection by default). */
  inbound_mode: Generated<"long_connection" | "webhook">;
  last_error: string | null;
  bot_user_id: string | null;
  tenant_id: string | null;
  /**
   * 0099_channel_connection_guide_ack.sql: the setup guide last set up with,
   * `{ guideId, version, hash, mode }`; null when unknown.
   */
  guide_ack: ColumnType<GuideAckJson | null, string | null | undefined, string | null>;
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
  /**
   * 0113: a scheduled group run's thread is still to bind; the account its thread row gets when
   * outbound has the run's first post (thread key = that message's id). Null otherwise.
   */
  pending_thread_account_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** 0018_channels.sql：出站投递发出的审批 / 提问卡片对应的 IM 消息（Task 11，用于更新卡片状态）。 */
export interface ChannelCardMessagesTable {
  conversation_id: string;
  connection_id: string;
  card_kind: "approval" | "question";
  card_id: string;
  /** 0039: null while the row is `pending` (recorded before the send returned). */
  message_id: string | null;
  /** 0039: `pending` = recorded before sending; `sent` = message_id is known. */
  status: Generated<"pending" | "sent">;
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
  /** 0068: the agent whose profile uses this avatar upload (set once, when it is saved). */
  agent_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** 预签名上传的用途：对话附件 / 技能包 zip / agent avatar image. */
export type AttachmentPurpose = "chat" | "skill-package" | "agent-avatar";

/** 技能版本的清单（`skill_versions.manifest`）。 */
export interface SkillManifest {
  name: string;
  description: string;
  files: { path: string; size: number; sha256: string }[];
  /**
   * Phase D: how the version can be invoked, read from its SKILL.md when it was written. Absent
   * means `{ model: true, user: true }` (every version written before phase D, and ordinary skills,
   * whose manifest is unchanged). No backfill (decided 2026-10-27).
   */
  invocation?: SkillInvocation;
}

/** 0024_skills.sql：技能（组织技能库 / agent 自己的技能）。 */
export interface SkillsTable {
  id: string;
  /** 0084: the owner shares this copy with other orgs. */
  shareable: Dflt<boolean>;
  org_id: string;
  scope: "org" | "agent";
  agent_id: string | null;
  name: string;
  description: string;
  current_version: number;
  /** 0076: null for a skill the kernel created (the plugin scope sync). */
  created_by: string | null;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
  /**
   * 0037, renamed in 0042: the source item (an app's skill records the app item) and version when
   * installed from the catalog.
   */
  catalog_item_id: ColumnType<string | null, string | null | undefined, string | null>;
  catalog_version: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0081: the platform skill this copy links to (null = none). */
  platform_skill_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0081: a pin keeps the copy on its own stored version (ruling B2). */
  pinned_version: ColumnType<number | null, number | null | undefined, number | null>;
  /** 0111: the agent a shared org skill came from (cleared when that agent is deleted). */
  origin_agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0111: the account that maintains a shared org skill. */
  maintainer_account_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** 0024_skills.sql：技能的版本。 */
export interface SkillVersionsTable {
  skill_id: string;
  version: number;
  manifest: Json<SkillManifest>;
  object_prefix: string;
  /** 0076: null for a version the kernel created (the plugin scope sync). */
  created_by: string | null;
  created_at: Ts;
  /**
   * 0037, renamed in 0042: this version's platform catalog source (NULL for custom uploads /
   * agent skills).
   */
  catalog_item_id: ColumnType<string | null, string | null | undefined, string | null>;
  catalog_version: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0051: the format of the plugin this version came from. */
  source_format: ColumnType<SourceFormat, SourceFormat | undefined, SourceFormat>;
  /** 0051: the plugin suggests pinning this skill (spec §9.1). */
  suggest_pinned: ColumnType<boolean, boolean | undefined, boolean>;
}

/** 0051: the format a plugin version was read from. */
export type SourceFormat = "capybara" | "claude-code";

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
  /** 0112: null for a share request and for a version proposal registered on the web. */
  requested_in_conversation: string | null;
  status: Generated<"pending" | "approved" | "rejected" | "cancelled">;
  /** 0111: a share of an agent skill with the org, or a new version of a shared skill. */
  kind: Dflt<"share" | "version">;
  decided_by: string | null;
  decided_at: TsNullable;
  created_at: Ts;
}

/** 0070_background_tasks.sql: a Bash command running in the background in a conversation's sandbox. */
export interface BackgroundTasksTable {
  id: string;
  org_id: string;
  conversation_id: string;
  sandbox_conversation_id: string;
  run_id: string;
  call_id: string;
  trigger_account_id: string;
  description: string;
  command: string;
  /** NULL while the launch is reserved but not started (0071). */
  sid: string | null;
  output_path: string;
  status: ColumnType<
    "running" | "completed" | "failed" | "stopped" | "timed_out" | "lost",
    string | undefined,
    string
  >;
  lost_reason: ColumnType<string | null, string | null | undefined, string | null>;
  exit_code: ColumnType<number | null, number | null | undefined, number | null>;
  started_at: Ts;
  finished_at: TsNullable;
  deadline_at: Date | string;
  /** NULL while the launch is reserved but not started (0071). */
  sandbox_created_at: Date | string | null;
  kill_pending: ColumnType<boolean, boolean | undefined, boolean>;
  read_offset: ColumnType<string, number | string | undefined, number | string>;
  /** Set while a stop is under way (0072); the poller skips such a task. */
  stopping_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** 0088, renamed in 0105: the device the task runs in. */
  device_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** 0023_sandboxes.sql: the legacy per-conversation sandbox; kept only for the cleanup job (0088). */
export interface LegacySandboxesTable {
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

type InstanceHandle = ColumnType<
  { id: string; [k: string]: unknown } | null,
  string | null | undefined,
  string | null
>;

/**
 * 0088_environments.sql, renamed in 0105: a device. A cloud device is one instance plus a kept file
 * system; a local device is a person's machine (device_machines).
 */
export interface DevicesTable {
  id: string;
  org_id: string;
  owner_kind: "personal";
  owner_account_id: string;
  name: ColumnType<string | null, string | null | undefined, string | null>;
  is_default: ColumnType<boolean, boolean | undefined, boolean>;
  /** 0093, renamed in 0105: `local` is a person's machine (device_machines). */
  source: "cloud" | "local";
  provider: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0096: the provider a demoted default was demoted from; null for every other device. */
  demoted_from_provider: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0117: a cloud device's own sandbox tier; null follows the org's default. */
  tier: ColumnType<SandboxTier | null, SandboxTier | null | undefined, SandboxTier | null>;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/** 0088_environments.sql, renamed in 0105: the instance and file system of a device. */
export interface DeviceInstancesTable {
  device_id: string;
  org_id: string;
  provider: ColumnType<string | null, string | null | undefined, string | null>;
  /** The provider's `FileSystemHandle`; null before the file system exists or after a reset. */
  fs_handle: ColumnType<FileSystemHandle | null, string | null | undefined, string | null>;
  fs_status: ColumnType<
    "none" | "ready" | "lost",
    "none" | "ready" | "lost" | undefined,
    "none" | "ready" | "lost"
  >;
  handle: InstanceHandle;
  status: ColumnType<
    "none" | "creating" | "running" | "suspended" | "destroyed",
    "none" | "creating" | "running" | "suspended" | "destroyed" | undefined,
    "none" | "creating" | "running" | "suspended" | "destroyed"
  >;
  last_used_at: Ts;
  running_since: TsNullable;
  created_at: Ts;
  suspended_at: TsNullable;
  destroyed_at: TsNullable;
  /** Fencing number: every status / handle write under the lock compares and increments it. */
  generation: ColumnType<number, number | undefined, number>;
  /** An instance was created at least once (only ever set to true). */
  had_instance: ColumnType<boolean, boolean | undefined, boolean>;
  /** How many times the files were reset (0095); a reset may bring back the same file system id. */
  fs_resets: ColumnType<number, number | undefined, number>;
  /** The old provider's instance left behind by a provider change. */
  prev_provider: ColumnType<string | null, string | null | undefined, string | null>;
  prev_handle: InstanceHandle;
  sweep_failed_at: TsNullable;
  /**
   * 0117: the limits in force on the instance, `{ tier, egress }`, plus `unapplied` when the
   * provider could not apply a newer value without a file reset; null = unknown (made before
   * 0117). Read with `readInstanceLimits` (`sandbox/tiers.ts`).
   */
  instance_limits: ColumnType<unknown | null, string | null | undefined, string | null>;
}

/**
 * 0093_connected_environments.sql, renamed in 0105: the machine of a local device. At most one
 * unrevoked row per device; revoking sets `revoked_at` and keeps the row.
 */
export interface DeviceMachinesTable {
  id: Generated<string>;
  org_id: string;
  device_id: string;
  account_id: string;
  /** A hash of the machine credential, never the credential itself. */
  credential_hash: string;
  name: string;
  os: string;
  arch: string;
  program_version: ColumnType<string | null, string | null | undefined, string | null>;
  mode: ColumnType<
    "os" | "docker" | null,
    "os" | "docker" | null | undefined,
    "os" | "docker" | null
  >;
  /** The roots the program exposes, as it reported them (a JSON array). */
  roots: ColumnType<unknown, string | null | undefined, string | null>;
  session_isolation: ColumnType<boolean, boolean | undefined, boolean>;
  last_seen_at: TsNullable;
  created_at: Ts;
  revoked_at: TsNullable;
  /** 0114: the features the program reported in its hello (`networkReport`, `policyOp`). */
  features: ColumnType<string[], string[] | undefined, string[]>;
  /** 0114: the program's local network policy summary (hello, refreshed by each `policy` op). */
  local_policy: ColumnType<unknown | null, string | null | undefined, string | null>;
  /** 0118: the `policy` ops sent whose answer is not recorded yet (`PendingPolicyOp[]`). */
  pending_policy_ops: ColumnType<unknown, string | undefined, string>;
}

/** 0088_environments.sql, renamed in 0105: the device a member's new conversations use by default. */
export interface DeviceDefaultsTable {
  org_id: string;
  account_id: string;
  device_id: string;
  updated_at: Ts;
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

/** 0029_model_purposes.sql：模型用途映射（org_id 为 null = 部署默认；组织可覆盖）。 */
export interface ModelPurposeMappingsTable {
  org_id: string | null;
  purpose: string;
  provider: string;
  model: string;
  params: Json;
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
  /** 两种回放模式的计划（`StoredCasePlan`），写入时算好。 */
  plan_step: Json<unknown>;
  plan_run: Json<unknown>;
  /** 用例原版本的模型（`ModelRef`）；没有定义时为 null。 */
  base_model: ColumnType<unknown | null, string | null | undefined, string | null>;
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
  consecutive_errors: ColumnType<number, number | undefined, number>;
  error: ColumnType<unknown | null, string | null | undefined, string | null>;
  estimate: Json<unknown>;
  created_by: string;
  created_at: Ts;
  started_at: TsNullable;
  finished_at: TsNullable;
}

export type EvalResultStatus = "pending" | "running" | "done" | "error" | "skipped";
/** 0029：评委状态（pending = 结果已 done、评委还没做）。 */
export type JudgeStatus = "none" | "pending" | "done" | "error" | "skipped";

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
  claimed_by: ColumnType<string | null, string | null | undefined, string | null>;
  judge_status: ColumnType<JudgeStatus, JudgeStatus | undefined, JudgeStatus>;
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
/** 0030, renamed in 0041: content-addressed extension packages (sha256 = the whole tgz). */
export interface ExtensionPackagesTable {
  sha256: string;
  /** The extension manifest name. */
  name: string;
  /** The npm package name from package.json. */
  package_name: string;
  version: string;
  size: Int8;
  /**
   * The plugin's reviewed extension section (`PluginExtensionSection` from plugin.json); rows stored
   * before 0.1.0 hold the old `capybara` section of package.json (both carry the static manifest).
   */
  section: Json<unknown>;
  blob_store: "object" | "pg";
  source: "npm" | "file" | "catalog" | "bootstrap";
  source_ref: string;
  uploaded_by: string | null;
  created_at: Ts;
  /** 0066: the plugin.json `displayName`; null without one and for packages stored before 0066. */
  display_name: ColumnType<
    { zh: string; en: string } | null,
    string | null | undefined,
    string | null
  >;
}

/**
 * 0100: catalog display files (plugin icons, connector template icons, setup guide files) by
 * sha256, shared by every version listing one (`catalog/catalog-files.ts`).
 */
export interface CatalogFilesTable {
  sha256: string;
  data: Buffer;
  touched_at: Ts;
}

/** 0030, renamed in 0041: package bytes when there is no object storage. */
export interface ExtensionBlobsTable {
  sha256: string;
  bytes: Buffer;
}

/** 0030, renamed in 0041: one install record (desired state) per extension. */
export interface ExtensionInstallsTable {
  name: string;
  sha256: string;
  version: string;
  source: "npm" | "file" | "catalog" | "bootstrap";
  desired_state: ColumnType<"enabled" | "disabled", "enabled" | "disabled" | undefined>;
  migrated_sha: string | null;
  installed_by: string | null;
  installed_at: Ts;
  updated_by: string | null;
  updated_at: Ts;
  /** 0034 (F-AA): the source item when installed through the platform catalog. */
  catalog_item_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * 0050: a required bootstrap plugin (enabled in every org without an org config row; cannot be
   * disabled or uninstalled). Written only by the bootstrap step.
   */
  required: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * 0097: when the desired state last became `enabled` (NULL while disabled). Of two enabled
   * providers of one single-provider extension point (left from before enabling a second was
   * refused) the earliest enabled is the one every replica loads.
   */
  enabled_at: TsNullable;
}

/** Which npm package owns an extension name (Ruling P3): written on first install, kept on uninstall. */
export interface ExtensionNameOwnersTable {
  name: string;
  package_name: string;
  created_at: Generated<Date>;
}

/** 0032, renamed in 0041: non-secret fields of the deployment-level extension config (secrets in `secrets`, org_id `_deployment`). */
export interface ExtensionDeploymentConfigsTable {
  plugin: string;
  config: ColumnType<Record<string, unknown>, string | undefined, string>;
  updated_by: string | null;
  updated_at: Ts;
}

export interface ExtensionReplicaStatusTable {
  replica_id: string;
  plugin: string;
  version: string;
  sha256: string | null;
  source: "config" | "install";
  state: "loaded" | "failed" | "unloaded" | "pending";
  reason: string | null;
  detail: string | null;
  /** The old version this replica still serves when this row's version did not load (see migration 0030). */
  serving_version: Generated<string | null>;
  /**
   * 0107: the package sha256 this replica actually serves for the plugin (the row's `sha256` when
   * loaded, the older package still running when the row's version is pending or failed, null when
   * none runs). Client code is delivered for the package a live replica serves.
   */
  serving_sha256: Generated<string | null>;
  http_replica_id: string | null;
  heartbeat_at: Ts;
}

/** A model disabled on the platform (`org_id` null) or in one org (0089, spec B §5.3). */
export interface ModelDisabledTable {
  org_id: string | null;
  provider: string;
  model: string;
  disabled_by: string | null;
  disabled_at: Ts;
}

/** One model call outside a conversation, e.g. an extension's embed call (0089, spec B §5.4). */
export interface ModelUsageTable {
  id: Generated<string>;
  org_id: string;
  extension: string;
  purpose: string;
  provider: string;
  model: string;
  input_tokens: number;
  occurred_at: Ts;
  reported_at: TsNullable;
  /** Set when the row's `usage.report` job gave up after its last attempt. */
  report_failed_at: TsNullable;
}

type NullableText = ColumnType<string | null, string | null | undefined, string | null>;
type NullableTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

/** 0113: a scheduled task (scheduled tasks spec §4). */
export interface ScheduledTasksTable {
  id: string;
  org_id: string;
  account_id: string;
  agent_id: string;
  name: string;
  prompt: string;
  trigger: ColumnType<ScheduleTrigger, string, string>;
  mode: ScheduleMode;
  conversation_id: NullableText;
  chat: ColumnType<ScheduleChat | null, string | null | undefined, string | null>;
  model: ColumnType<ModelRef | null, string | null | undefined, string | null>;
  effort: NullableText;
  device_id: NullableText;
  status: ColumnType<ScheduleStatus, ScheduleStatus | undefined, ScheduleStatus>;
  pause_reason: ColumnType<
    SchedulePauseReason | null,
    SchedulePauseReason | null | undefined,
    SchedulePauseReason | null
  >;
  paused_by: NullableText;
  next_run_at: NullableTs;
  jitter_seconds: ColumnType<number, number | undefined, number>;
  expires_at: NullableTs;
  consecutive_failures: ColumnType<number, number | undefined, number>;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: NullableTs;
}

/** 0113: one tick (or trial run) of a scheduled task; unique per (task, tick) when not trial. */
export interface ScheduledTaskRunsTable {
  id: string;
  task_id: string;
  org_id: string;
  scheduled_for: Date | string;
  fired_at: NullableTs;
  trial: ColumnType<boolean, boolean | undefined, boolean>;
  /** A person's "run now" (trial or not): runs even while the task is paused. */
  manual: ColumnType<boolean, boolean | undefined, boolean>;
  conversation_id: NullableText;
  run_id: NullableText;
  status: ColumnType<TaskRunStatus, TaskRunStatus | undefined, TaskRunStatus>;
  skip_reason: ColumnType<
    TaskRunSkipReason | null,
    TaskRunSkipReason | null | undefined,
    TaskRunSkipReason | null
  >;
  error: NullableText;
  missing_grants: ColumnType<string[], string | undefined, string>;
}

/** 0113: a scheduled task's remembered grants (same shape as `conversation_tool_grants`). */
export interface ScheduledTaskGrantsTable {
  task_id: string;
  tool_key: string;
  spec_hash: string;
  connector_id: string | null;
  created_at: Ts;
}

export interface KernelDatabase {
  accounts: AccountsTable;
  account_initial_passwords: AccountInitialPasswordsTable;
  identities: IdentitiesTable;
  local_passwords: LocalPasswordsTable;
  orgs: OrgsTable;
  memberships: MembershipsTable;
  invitations: InvitationsTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  deployment_settings: DeploymentSettingsTable;
  extension_org_configs: ExtensionOrgConfigsTable;
  extension_org_overrides: ExtensionOrgOverridesTable;
  org_tool_switches: OrgToolSwitchesTable;
  audit_events: AuditEventsTable;
  secrets: SecretsTable;
  agents: AgentsTable;
  agent_versions: AgentVersionsTable;
  agent_members: AgentMembersTable;
  conversations: ConversationsTable;
  conversation_events: ConversationEventsTable;
  conversation_queue: ConversationQueueTable;
  file_previewers: FilePreviewersTable;
  org_extension_point_defaults: OrgExtensionPointDefaultsTable;
  runs: RunsTable;
  subagent_dispatches: SubagentDispatchesTable;
  agent_templates: AgentTemplatesTable;
  agent_template_versions: AgentTemplateVersionsTable;
  lg_checkpoints: LgCheckpointsTable;
  lg_checkpoint_writes: LgCheckpointWritesTable;
  connectors: ConnectorsTable;
  connector_tools: ConnectorToolsTable;
  connector_tool_account_policies: ConnectorToolAccountPoliciesTable;
  tool_grants: ToolGrantsTable;
  conversation_tool_grants: ConversationToolGrantsTable;
  approvals: ApprovalsTable;
  questions: QuestionsTable;
  tool_outputs: ToolOutputsTable;
  tool_specs: ToolSpecsTable;
  extension_permission_snapshots: ExtensionPermissionSnapshotsTable;
  channel_connections: ChannelConnectionsTable;
  channel_threads: ChannelThreadsTable;
  channel_deliveries: ChannelDeliveriesTable;
  channel_card_messages: ChannelCardMessagesTable;
  org_anonymous_accounts: OrgAnonymousAccountsTable;
  directory_exclusions: DirectoryExclusionsTable;
  attachments: AttachmentsTable;
  sandboxes: LegacySandboxesTable;
  devices: DevicesTable;
  device_instances: DeviceInstancesTable;
  device_defaults: DeviceDefaultsTable;
  device_machines: DeviceMachinesTable;
  background_tasks: BackgroundTasksTable;
  scheduled_tasks: ScheduledTasksTable;
  scheduled_task_runs: ScheduledTaskRunsTable;
  scheduled_task_grants: ScheduledTaskGrantsTable;
  skills: SkillsTable;
  skill_versions: SkillVersionsTable;
  skill_change_requests: SkillChangeRequestsTable;
  model_prices: ModelPricesTable;
  eval_sets: EvalSetsTable;
  eval_cases: EvalCasesTable;
  eval_runs: EvalRunsTable;
  eval_results: EvalResultsTable;
  model_purpose_mappings: ModelPurposeMappingsTable;
  model_disabled: ModelDisabledTable;
  model_usage: ModelUsageTable;
  extension_packages: ExtensionPackagesTable;
  extension_blobs: ExtensionBlobsTable;
  extension_installs: ExtensionInstallsTable;
  extension_replica_status: ExtensionReplicaStatusTable;
  extension_name_owners: ExtensionNameOwnersTable;
  extension_deployment_configs: ExtensionDeploymentConfigsTable;
  catalog_items: CatalogItemsTable;
  catalog_item_versions: CatalogItemVersionsTable;
  catalog_files: CatalogFilesTable;
  marketplaces: MarketplacesTable;
  marketplace_entries: MarketplaceEntriesTable;
  marketplace_icons: MarketplaceIconsTable;
  marketplace_icon_failures: MarketplaceIconFailuresTable;
  plugin_import_staging: PluginImportStagingTable;
  catalog_requests: CatalogRequestsTable;
  catalog_org_grants: CatalogOrgGrantsTable;
  catalog_item_scope_orgs: CatalogItemScopeOrgsTable;
  catalog_item_org_switches: CatalogItemOrgSwitchesTable;
  platform_skills: PlatformSkillsTable;
  platform_skill_versions: PlatformSkillVersionsTable;
  platform_agent_templates: PlatformAgentTemplatesTable;
  platform_agent_template_versions: PlatformAgentTemplateVersionsTable;
  platform_connector_templates: PlatformConnectorTemplatesTable;
  platform_themes: PlatformThemesTable;
  platform_theme_versions: PlatformThemeVersionsTable;
  component_scope_orgs: ComponentScopeOrgsTable;
  component_org_switches: ComponentOrgSwitchesTable;
  plugin_installs: PluginInstallsTable;
  plugin_install_components: PluginInstallComponentsTable;
  extension_catalog_sources: ExtensionCatalogSourcesTable;
  bootstrap_runs: BootstrapRunsTable;
  org_notices: OrgNoticesTable;
  platform_notices: PlatformNoticesTable;
  plugin_scope_sync_failures: PluginScopeSyncFailuresTable;
  extension_client_builds: ExtensionClientBuildsTable;
  extension_client_reports: ExtensionClientReportsTable;
  outbox: OutboxTable;
}

/**
 * 0119: the transactional outbox (transactional outbox spec §4). A row is a BullMQ job owed by a
 * committed transaction; deleted on delivery, so only dead rows (`dead_at` set) stay.
 */
export interface OutboxTable {
  /** bigint identity; the pg driver reads it as a string. */
  id: Generated<string>;
  queue: string;
  job_name: string;
  /** Unique per queue: a second add of the same job before delivery is a no-op. */
  job_id: string;
  data: Json;
  /** The job's delay target; null runs it now. */
  run_at: Date | null;
  /** Null for platform work. */
  org_id: string | null;
  attempts: Generated<number>;
  next_attempt_at: Generated<Date>;
  last_error: string | null;
  dead_at: Date | null;
  created_at: Generated<Date>;
}

/**
 * 0107: the client files of an extension package (client extensions spec §9.1), keyed by the
 * package sha256 (the build id). Paths are the manifest keys (`./dist/client/...`); the files live
 * in object storage under `deployment/<object_prefix>`.
 */
export interface ExtensionClientBuildsTable {
  package_sha256: string;
  plugin: string;
  /** `./dist/client/client.mjs`, or null for CSS-only decoration. */
  entry: string | null;
  styles: ColumnType<string[], string[], string[]>;
  assets: ColumnType<string[], string[], string[]>;
  /** Manifest key -> `sha384-<base64>`, checked against the bytes when stored. */
  integrity: Json<Record<string, string>>;
  /** Manifest key -> size in bytes. */
  sizes: Json<Record<string, number>>;
  api_version: number;
  /** Relative to `deployment/`: `platform/client/<plugin>/<sha256>/`. */
  object_prefix: string;
  created_at: Ts;
}

/** 0107: crash and load reports of client code (client extensions spec §10.4). */
export interface ExtensionClientReportsTable {
  plugin: string;
  build: string;
  /** Null for admin pages. */
  org_id: string | null;
  contribution: string | null;
  kind: "load" | "render" | "event" | "api" | "budget";
  count: Generated<number>;
  first_at: Ts;
  last_at: Ts;
  last_message: string;
}

/** 0084 (0121 dropped `skill_renamed`): the kinds of {@link OrgNoticesTable}. */
export type OrgNoticeKind =
  | "item_shared"
  | "shared_item_updated"
  | "upload_confirmed"
  | "upload_rejected";

/** 0082: a notice for an org's admins (an inbox item), until one of them dismisses it. */
export interface OrgNoticesTable {
  id: string;
  org_id: string;
  kind: OrgNoticeKind;
  /** The kind's shape (`OrgNoticeDetails` in `inbox/org-notices.ts`). */
  detail: Json<Record<string, unknown>>;
  created_at: Ts;
  dismissed_at: TsNullable;
  dismissed_by: NullableCol<string>;
}

/** 0084: a notice for the super admins (platform inbox), until one of them dismisses it. */
export interface PlatformNoticesTable {
  id: string;
  kind: "ownership_transferred";
  detail: Json<Record<string, unknown>>;
  created_at: Ts;
  dismissed_at: TsNullable;
  dismissed_by: NullableCol<string>;
}

/**
 * 0083: what a failed scope sync attempt was doing: turning the plugin on, off, or installing the
 * dependencies a platform update added to a live install.
 */
export type ScopeSyncOp = "install" | "uninstall" | "dependencies";

/**
 * 0083: an open failure of the plugin scope sync for one (item, org): its last attempt failed; the
 * next sync of the pair that does not fail deletes the row.
 */
export interface PluginScopeSyncFailuresTable {
  item_id: string;
  org_id: string;
  op: ScopeSyncOp;
  /** The `ApiError` code, else `internal`. */
  code: string;
  message: string;
  failed_at: Ts;
}

/** 0050: one row per bootstrap manifest the bootstrap step completed. */
export interface BootstrapRunsTable {
  /** sha256 (hex) of the bootstrap manifest. */
  manifest_sha256: string;
  completed_at: Ts;
  results: ColumnType<unknown, string, string>;
}

/** 0034_directory.sql, renamed in 0042, one kind (plugin) since 0044: platform catalog items. */
export interface CatalogItemsTable {
  id: string;
  /** The plugin name (one live item per name). */
  name: string;
  /** 0046: null for a git plugin without package.json. */
  package_name: string | null;
  publisher: string;
  display_name: ColumnType<
    { zh: string; en: string } | null,
    string | null | undefined,
    string | null
  >;
  description: string;
  policy: ColumnType<
    "allow" | "needs_approval" | "disabled",
    "allow" | "needs_approval" | "disabled" | undefined,
    "allow" | "needs_approval" | "disabled"
  >;
  latest_version: string;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Ts;
  deleted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** 0035, renamed in 0042: the marketplace it was imported from (null once that is deleted). */
  marketplace_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0075: who the plugin is offered to (`named`: the rows of `catalog_item_scope_orgs`). */
  scope: ColumnType<
    "all" | "optional" | "named",
    "all" | "optional" | "named" | undefined,
    "all" | "optional" | "named"
  >;
  /** 0075: shipped with the deployment (required bootstrap plugins); always scope `all`. */
  builtin: ColumnType<boolean, boolean | undefined, boolean>;
  /** 0075: switched off for every org by the super admin. */
  disabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** 0075: bumped on every scope change. */
  scope_version: ColumnType<number, number | undefined, number>;
  /** 0077: orgs outside a `named` item's list see it as requestable (never usable). */
  shown_to_others: ColumnType<boolean, boolean | undefined, boolean>;
  /** 0082: the version its platform components were last written from (null: never). */
  platform_synced_version: NullableCol<string>;
  /** 0084: the owning org (null = the platform). */
  owner_org_id: NullableDflt<string>;
  /** 0084: the owner shares it with other orgs (the gate is `owner_org_id IS NULL OR shareable`). */
  shareable: Dflt<boolean>;
  /** 0084: an upload waits for the super admin's confirmation of its permission digest. */
  awaiting_confirmation: Dflt<boolean>;
  /** 0084: the uploaded version not yet confirmed. */
  pending_version: NullableDflt<string>;
  pending_by: NullableDflt<string>;
  pending_at: NullableDflt<Date | string>;
}

/** 0075: the orgs a `named` item is offered to. */
export interface CatalogItemScopeOrgsTable {
  item_id: string;
  org_id: string;
}

/** 0075: an org's on / off switch of an item's components. */
export interface CatalogItemOrgSwitchesTable {
  item_id: string;
  org_id: string;
  enabled: boolean;
  updated_by: NullableCol<string>;
  updated_at: Ts;
}

type ScopeMode = "follow" | "own";
type ComponentScope = "all" | "optional" | "named";
type ComponentKind = "skill" | "agent_template" | "connector_template" | "theme";
type Dflt<T> = ColumnType<T, T | undefined, T>;
type NullableDflt<T> = ColumnType<T | null, T | null | undefined, T | null>;

/** 0081: the scope columns every platform component carries (ruling C2). */
interface PlatformScopeColumns {
  scope_mode: Dflt<ScopeMode>;
  scope: Dflt<ComponentScope>;
  disabled: Dflt<boolean>;
  shown_to_others: Dflt<boolean>;
  scope_version: Dflt<number>;
}

/** 0081: a skill owned by the deployment (ruling A2). */
export interface PlatformSkillsTable extends PlatformScopeColumns {
  id: string;
  /** 0084: the owning org (null = the platform). */
  owner_org_id: NullableDflt<string>;
  /** 0084: the org it was created in; never changed (F27). */
  origin_org_id: NullableDflt<string>;
  /** 0084: the owner shares it with other orgs. */
  shareable: Dflt<boolean>;
  catalog_item_id: NullableDflt<string>;
  plugin_name: NullableDflt<string>;
  name: string;
  description: string;
  description_zh: NullableDflt<string>;
  current_version: number;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/** 0081: one version of a platform skill; files live under `object_prefix` in `deployment/`. */
export interface PlatformSkillVersionsTable {
  skill_id: string;
  version: number;
  manifest: Json<SkillManifest>;
  object_prefix: string;
  catalog_version: NullableDflt<string>;
  source_format: Dflt<SourceFormat>;
  suggest_pinned: Dflt<boolean>;
  updated_on_own: Dflt<boolean>;
  created_by: NullableDflt<string>;
  created_at: Ts;
}

/** 0081: an agent template owned by the deployment. */
export interface PlatformAgentTemplatesTable extends PlatformScopeColumns {
  id: string;
  /** 0084: the owning org (null = the platform). */
  owner_org_id: NullableDflt<string>;
  /** 0084: the org it was created in; never changed (F27). */
  origin_org_id: NullableDflt<string>;
  /** 0084: the owner shares it with other orgs. */
  shareable: Dflt<boolean>;
  catalog_item_id: NullableDflt<string>;
  plugin_name: NullableDflt<string>;
  name: string;
  description: NullableDflt<string>;
  description_zh: NullableDflt<string>;
  current_version: number;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/** 0081: one version of a platform agent template. */
export interface PlatformAgentTemplateVersionsTable {
  template_id: string;
  version: number;
  definition: Json<unknown>;
  object_prefix: NullableDflt<string>;
  catalog_version: NullableDflt<string>;
  source_format: Dflt<SourceFormat>;
  suggest_pinned: Dflt<boolean>;
  updated_on_own: Dflt<boolean>;
  created_by: NullableDflt<string>;
  created_at: Ts;
}

/** 0081: a connector template of a catalog item, with its own scope; connectors stay per org. */
export interface PlatformConnectorTemplatesTable extends PlatformScopeColumns {
  id: string;
  /** 0084: the owning org (null = the platform). */
  owner_org_id: NullableDflt<string>;
  /** 0084: the owner shares it with other orgs. */
  shareable: Dflt<boolean>;
  catalog_item_id: string;
  template_id: string;
  current_version: string;
  file: Json<unknown>;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/** 0093: a theme (themes spec §6); every theme comes from a plugin, owned by the platform or an org. */
export interface PlatformThemesTable extends PlatformScopeColumns {
  id: string;
  /** The owning org (null = the platform). */
  owner_org_id: NullableDflt<string>;
  /** The org it was created in; never changed. */
  origin_org_id: NullableDflt<string>;
  /** The owner shares it with other orgs. */
  shareable: Dflt<boolean>;
  catalog_item_id: NullableDflt<string>;
  plugin_name: NullableDflt<string>;
  name: string;
  description: NullableDflt<string>;
  description_zh: NullableDflt<string>;
  current_version: number;
  created_at: Ts;
  updated_at: Ts;
  deleted_at: TsNullable;
}

/**
 * 0093: one version of a theme; `definition` is the parsed theme file, its fonts and logo live
 * under `object_prefix` in `deployment/` (null without assets).
 */
export interface PlatformThemeVersionsTable {
  theme_id: string;
  version: number;
  definition: Json<ParsedTheme>;
  object_prefix: NullableDflt<string>;
  catalog_version: NullableDflt<string>;
  updated_on_own: Dflt<boolean>;
  created_by: NullableDflt<string>;
  created_at: Ts;
}

/** 0081: the orgs an own-scope `named` component is offered to. */
export interface ComponentScopeOrgsTable {
  kind: ComponentKind;
  component_id: string;
  org_id: string;
}

/** 0081: an org's on / off switch of a component. */
export interface ComponentOrgSwitchesTable {
  kind: ComponentKind;
  component_id: string;
  org_id: string;
  enabled: boolean;
  updated_by: NullableCol<string>;
  updated_at: Ts;
}

/**
 * 0034, renamed in 0042, reshaped in 0044: the versions of a platform catalog item. `manifest` is
 * the normalized plugin.json (skills and connector templates listed explicitly); `extension_sha256`
 * the plugin's extension package in `extension_packages` (null without an extension); `files` the
 * version's stored files: display files (icons, setup guide files) in `catalog_files` (0100), the
 * rest (skills, connector and agent templates) under `object_prefix`.
 */
export interface CatalogItemVersionsTable {
  item_id: string;
  version: string;
  manifest: Json<unknown>;
  source: "file" | "npm" | "marketplace" | "git" | "bootstrap";
  source_ref: string;
  integrity: string | null;
  /** 0046: where the plugin came from (git location, archive URL or npm registry). */
  source_detail: ColumnType<
    Record<string, unknown> | null,
    string | null | undefined,
    string | null
  >;
  /** 0046: the content digest of the imported files (null before phase A1). */
  content_digest: ColumnType<string | null, string | null | undefined, string | null>;
  object_prefix: string | null;
  extension_sha256: string | null;
  files: Json<{ path: string; size: number; sha256: string }[]>;
  size: Int8;
  imported_by: string | null;
  imported_at: Generated<Date>;
  /** 0051: the format the version was read from. */
  source_format: ColumnType<SourceFormat, SourceFormat | undefined, SourceFormat>;
  /** 0051: the translation report of a Claude Code plugin (null for a native plugin). */
  translation: ColumnType<unknown | null, string | null | undefined, string | null>;
  /** 0051: the root LICENSE text (at most 64 KiB). */
  license_text: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0051: the root LICENSE was too long (or not UTF-8) to store. */
  license_truncated: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * 0084 (ruling P3-52): when the version was applied or confirmed (default: written; an org's
   * upload writes null until applied). Only applied, not rejected versions serve other orgs.
   */
  applied_at: TsNullable;
  /** 0084 (ruling P3-52): when the super admin rejected this pending org version. */
  rejected_at: TsNullable;
  /**
   * 0107: the keys of `suggestedAppearance.replacements` in plugin.json order (jsonb does not keep
   * key order); null without replacements.
   */
  appearance_order: ColumnType<string[] | null, string[] | null | undefined, string[] | null>;
}

/** 0035_catalogs.sql, renamed in 0042: marketplaces (official / custom). */
export interface MarketplacesTable {
  id: string;
  name: string;
  url: string;
  mirrors: Json<string[]>;
  builtin: ColumnType<boolean, boolean | undefined, boolean>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  etag: ColumnType<string | null, string | null | undefined, string | null>;
  last_refreshed_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  last_status: ColumnType<
    "ok" | "error" | "never",
    "ok" | "error" | "never" | undefined,
    "ok" | "error" | "never"
  >;
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
  /** 0046: http (a marketplace.json URL) or git (a repository). */
  form: ColumnType<"http" | "git", "http" | "git" | undefined, "http" | "git">;
  /** 0046: the git ref a git marketplace follows (null = the remote HEAD). */
  ref: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0046: the commit of a git marketplace's last successful refresh. */
  last_commit: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0046: the manifest's `owner.name` at the last successful refresh. */
  owner_name: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0051: entries the last successful refresh could not store (`{ name, reason }[]`). */
  skipped: ColumnType<{ name: string; reason: string }[], string | undefined, string>;
  /** 0101: the git commit whose repository-path icons were last stored completely. */
  icons_commit: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * 0035, renamed in 0042, reshaped in 0044: cached marketplace entries (replaced as a whole on each
 * successful refresh). One row per `marketplace.json` entry, keyed `(source_id, name, version)`;
 * `version` is `''` for an entry without one; `npm` is the npm package of an npm source (else null).
 */
export interface MarketplaceEntriesTable {
  source_id: string;
  name: string;
  version: ColumnType<string, string | undefined, string>;
  npm: ColumnType<string | null, string | null | undefined, string | null>;
  entry: Json<unknown>;
  /** 0047: the branch head of a branch-following git entry already imported (null: unknown). */
  head_commit: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0048: the git tree oid of the entry's plugin directory (path entries; git entries with a path). */
  tree_oid: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0051: the Claude marketplace entry's overlay (`ClaudeEntryOverlay`; null for a Capybara entry). */
  claude: ColumnType<unknown | null, string | null | undefined, string | null>;
  updated_at: Ts;
}

/**
 * 0101: marketplace entry icons, one per (marketplace, the entry's `icon` as written), downloaded
 * on refresh (`catalog/marketplace-icons.ts`).
 */
export interface MarketplaceIconsTable {
  source_id: string;
  ref: string;
  sha256: string;
  content_type: "image/svg+xml" | "image/png";
  data: Buffer;
  fetched_at: Ts;
}

/** 0101: icon URLs whose last download failed, retried after a backoff. */
export interface MarketplaceIconFailuresTable {
  source_id: string;
  ref: string;
  failed_at: Ts;
  attempts: ColumnType<number, number | undefined, number>;
}

/**
 * 0036_app_import_staging.sql, renamed in 0043, reshaped in 0044: a staged plugin import (written by
 * prepare, deleted by confirm, expires after 24 hours). `manifest` holds what confirm writes.
 */
export interface PluginImportStagingTable {
  id: string;
  /** 0084: the org whose upload this is (null: the super admin's import). */
  org_id: NullableDflt<string>;
  review: Json<unknown>;
  manifest: Json<unknown>;
  object_prefix: string | null;
  source: Json<unknown>;
  created_by: string | null;
  created_at: Generated<Date>;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

type NullableCol<T> = ColumnType<T | null, T | null | undefined, T | null>;

/** 0077 / 0085 / 0115: the kinds of a catalog request. */
type CatalogRequestKindCol =
  | "access"
  | "import"
  | "enable"
  | "connector_setup"
  | "network_allowlist";

/**
 * 0037, renamed in 0042, kinds since 0077: an org's catalog requests. `stage` (org / deployment) is
 * still written (`enable` -> org, else deployment) but no longer read.
 */
export interface CatalogRequestsTable {
  id: string;
  org_id: string;
  /** 0077: null for an `import` request until its confirm writes the item. */
  item_id: NullableCol<string>;
  version: NullableCol<string>;
  /** 0077: what the request asks for (spec §5.1). */
  kind: ColumnType<CatalogRequestKindCol, CatalogRequestKindCol | undefined, CatalogRequestKindCol>;
  /**
   * 0115: what a `network_allowlist` request asks for (`{ hosts, conversationId, agentId }`); null
   * for other kinds.
   */
  detail: ColumnType<unknown | null, string | null | undefined, string | null>;
  /** 0085: the agent of a `connector_setup` request (cascades with the agent). */
  agent_id: NullableCol<string>;
  /** 0085: the template connector keys a `connector_setup` request still waits for. */
  pending_keys: ColumnType<string[] | null, string | null | undefined, string | null>;
  /** 0077: the marketplace entry of an `import` request (null once the marketplace is deleted). */
  marketplace_id: NullableCol<string>;
  entry_name: NullableCol<string>;
  entry_version: NullableCol<string>;
  /** 0077: the optional reason of a rejection. */
  reason: NullableCol<string>;
  /** 0077: the prepared import of an approved `import` request. */
  staging_id: NullableCol<string>;
  /** 0077: the requester dismissed the decision from the inbox. */
  dismissed_at: NullableCol<Date>;
  stage: "org" | "deployment";
  requested_by: string | null;
  note: ColumnType<string, string | undefined, string>;
  status: ColumnType<
    "pending" | "approved" | "rejected" | "cancelled",
    "pending" | "approved" | "rejected" | "cancelled" | undefined,
    "pending" | "approved" | "rejected" | "cancelled"
  >;
  decided_by: NullableCol<string>;
  decided_at: NullableCol<Date>;
  org_decided_by: NullableCol<string>;
  org_decided_at: NullableCol<Date>;
  created_at: Generated<Date>;
}

/**
 * 0037, renamed in 0041: the catalog items that brought an extension into the deployment (plugin
 * and app items).
 */
export interface ExtensionCatalogSourcesTable {
  plugin: string;
  item_id: string;
  created_at: Generated<Date>;
}

/** 0037, renamed in 0042: a super admin's approval for an org to install a needs_approval item. */
export interface CatalogOrgGrantsTable {
  item_id: string;
  org_id: string;
  granted_by: string | null;
  granted_at: Generated<Date>;
}

/** 0037：应用在组织里的安装。 */
export interface PluginInstallsTable {
  id: string;
  org_id: string;
  item_id: string;
  version: string;
  /** 0049: `upgrading` while an in-place upgrade runs. */
  status: "installing" | "installed" | "failed" | "uninstalling" | "upgrading";
  installed_by: string | null;
  installed_at: Generated<Date>;
  error: ColumnType<unknown, string | null | undefined, string | null>;
  /**
   * 0049: the journal of the running upgrade, `{ id, from, to, startedAt, done }` with `done` the
   * `UpgradeStep`s of catalog/plugin-install.ts (read by `journalEntries`); null otherwise.
   */
  upgrade: ColumnType<unknown, string | null | undefined, string | null>;
}

/**
 * 0037: the components of a plugin install (created = this install created it); kind 'plugin'
 * (0045) is a dependency install, ref = its plugin_installs id.
 */
export interface PluginInstallComponentsTable {
  install_id: string;
  /** 0053: 'agent_template', ref = the agent_templates id; 0093: 'theme', ref = the platform_themes id. */
  kind: "extension" | "connector" | "skill" | "plugin" | "agent_template" | "theme";
  ref: string;
  created: boolean;
  skill_version: NullableCol<number>;
  /** 0049: the connector template a connector component was created from (null otherwise). */
  template_id: NullableCol<string>;
  /**
   * 0049: an upgrade removed the component from the plugin but kept it (an agent still uses it):
   * "no longer in the plugin"; still this install's for uninstall.
   */
  dropped: ColumnType<boolean, boolean | undefined, boolean>;
}

export type KernelSchemaDb = Kysely<KernelDatabase>;

/** 把无类型的 Kysely 实例收窄成内核 schema 视图（`capybara`）。 */
// biome-ignore lint/suspicious/noExplicitAny: 入口处接收无表结构类型的实例
export function kernelDb(db: Kysely<any>): KernelSchemaDb {
  return db.withSchema("capybara") as unknown as KernelSchemaDb;
}
