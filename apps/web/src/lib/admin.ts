import type { ExtensionStatus } from "./admin-extensions";
import { apiFetch } from "./api";
import type { LocalizedName } from "./catalog";
import type { CompactionSettings, CompactionSettingsPatch } from "./compaction";
import type { SandboxTier } from "./devices";
import type { UiArrangementEntry } from "./ui";

/**
 * 超级管理员后台（`/api/v1/admin/*`，内核 `admin/admin.controller.ts`）。只有超级管理员能调用，
 * 界面上的隐藏只是方便，最终由内核判定。
 */

/** The admin overview's numbers (`GET /admin/overview`, kernel `admin/overview.service.ts`). */
export interface AdminOverview {
  orgs: number;
  accounts: number;
  /**
   * What waits for a super admin: the platform inbox total plus the extensions, plugin updates and
   * model providers of {@link AdminAttention} (counted in full, not capped), every dead outbox
   * row and the run queue's lost-jobs item.
   */
  attentionTotal: number;
  /** An attention list could not be read: `attentionTotal` leaves its items out. */
  partial?: boolean;
}

/**
 * Why an extension needs a look: `config` (missing deployment config while `pending_config`, else
 * invalid), `load_failed`, `approval`, `dependency`, `conflict`, `converging`, `legacy_format`.
 */
export type AttentionExtensionReason =
  | "config"
  | "load_failed"
  | "approval"
  | "dependency"
  | "conflict"
  | "converging"
  | "legacy_format";

/** What is wrong with a model provider: its model list failed, or no usable chat model. */
export type AttentionProviderProblem = "list_failed" | "no_chat_model";

/** An attention list (a source the kernel reads on its own). */
export type AttentionSource = "extensions" | "updates" | "providers" | "outbox" | "queue";

export interface AttentionExtension {
  name: string;
  displayName: LocalizedName | null;
  /** The plugin's icon URL, or null (the mark falls back to the initial). */
  icon: string | null;
  status: ExtensionStatus;
  reason: AttentionExtensionReason;
}

/** A platform plugin whose marketplace has a newer version than the newest imported one. */
export interface AttentionUpdate {
  itemId: string;
  name: string;
  displayName: LocalizedName | null;
  icon: string | null;
  version: string;
  marketplaceVersion: string;
  marketplaceId: string | null;
  /** The marketplace's name; null without one. */
  marketplaceName: string | null;
}

export interface AttentionProvider {
  /** The provider's plugin name. */
  plugin: string;
  displayName: LocalizedName | null;
  icon: string | null;
  problem: AttentionProviderProblem;
}

/**
 * Background work the kernel could not queue: how many outbox rows are dead, and since when (the
 * rows: `GET /admin/outbox/dead`).
 */
export interface AttentionOutboxDead {
  kind: "outbox_dead";
  count: number;
  oldestAt: string;
}

/**
 * The run queue lost background jobs (Redis lost data): how many were queued again and when the
 * last loss was. The item stays a week after the last loss.
 */
export interface AttentionQueueLostJobs {
  kind: "queue_lost_jobs";
  count: number;
  lastAt: string;
}

/**
 * `GET /admin/overview/attention`: what needs a super admin besides the inbox, each list capped
 * (the rest counted in `more`); `unavailable` names the lists the kernel could not read.
 */
export interface AdminAttention {
  extensions: AttentionExtension[];
  updates: AttentionUpdate[];
  providers: AttentionProvider[];
  /** At most one item, when some outbox rows are dead. */
  outbox: AttentionOutboxDead[];
  /** At most one item, when the run queue lost jobs in the last week. */
  queue: AttentionQueueLostJobs[];
  more: Record<AttentionSource, number>;
  unavailable: AttentionSource[];
}

/** A kernel role (`roles` in the kernel config). */
export type ReplicaRole = "api" | "worker" | "gateway";

/** A live kernel replica (`GET /admin/overview/health`). */
export interface AdminHealthReplica {
  /** The process id. */
  id: string;
  roles: ReplicaRole[];
  version: string;
  startedAt: string;
  /** The configured `http.replicaId`, null when unset. */
  httpReplicaId: string | null;
}

/** One kernel queue: counts only, never job data or a failure text. */
export interface AdminHealthQueue {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  /** Failed jobs still kept (each queue keeps the last 5000). */
  failed: number;
  /** Of those, the ones that failed in the last 24 hours. */
  failedLastDay: number;
}

/** A source the kernel could not read right now (its numbers are null). */
export type AdminHealthSource = "redis" | "database";

/**
 * `GET /admin/overview/health` (kernel `admin/health.service.ts`): the kernel version, the live
 * replicas and their roles, the kernel queues, and channel, device and sandbox counts. Each
 * source degrades on its own: a number the kernel could not read is null, `unavailable` names
 * the sources.
 */
export interface AdminHealth {
  kernel: { version: string };
  /** Live replicas, oldest start first. */
  replicas: AdminHealthReplica[] | null;
  /** Live replicas per role (a replica with several roles counts in each). */
  roles: Record<ReplicaRole, number> | null;
  /** The kernel queues in a fixed order. */
  queues: AdminHealthQueue[] | null;
  channels: {
    online: number | null;
    offline: number | null;
    webhook: number | null;
    disabled: number | null;
    error: number | null;
  };
  devices: { online: number | null; local: number | null };
  sandboxes: {
    running: number;
    suspended: number;
    /** Running instances per provider (most first). */
    byProvider: { provider: string; running: number }[];
  } | null;
  unavailable: AdminHealthSource[];
}

/** Tokens of one day; the four chat kinds do not overlap, `embedding` is `ctx.models.embed` input. */
export interface AdminUsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  embedding: number;
}

/** One calendar day of the usage week, in the answer's zone. */
export interface AdminUsageDay {
  /** `YYYY-MM-DD` in the answer's `tz`. */
  date: string;
  /** Runs created that day (sub-agent and eval replay runs included). */
  runs: number;
  tokens: AdminUsageTokens;
  /** Estimated cost in `currency`; null when the day used tokens and none had a price. */
  cost: number | null;
}

/** One org's week: totals only (never per account, agent or conversation). */
export interface AdminUsageOrg {
  orgId: string;
  name: string;
  runs: number;
  /** Every token kind summed. */
  tokens: number;
  cost: number | null;
}

/**
 * `GET /admin/overview/usage?tz=` (kernel `admin/usage.service.ts`): runs, tokens and estimated
 * cost per calendar day in `tz` over today and the 6 days before (today last), and the 10 orgs
 * that used the most tokens, the rest summed in `otherOrgs`. A null cost is "not priced", never 0.
 */
export interface AdminUsageWeek {
  from: string;
  to: string;
  tz: string;
  /** The deployment setting `priceCurrency`. */
  currency: string;
  days: AdminUsageDay[];
  /** Some tokens of the week had no price: the costs count only the priced ones. */
  costPartial: boolean;
  orgs: AdminUsageOrg[];
  otherOrgs: { count: number; runs: number; tokens: number; cost: number | null };
}

/**
 * One platform-level audit event (`GET /admin/audit`, org-less events only): who (null: the
 * kernel), whether through a personal token or their agent, the action and its target. Never the
 * event's detail.
 */
export interface PlatformAuditEvent {
  id: string;
  at: string;
  actor: { id: string; name: string | null; email: string | null } | null;
  viaToken: boolean;
  viaAgent: boolean;
  action: string;
  target: string | null;
}

/** A page of platform audit events, newest first; `next` is the `after` of the next page. */
export interface PlatformAuditPage {
  events: PlatformAuditEvent[];
  next: string | null;
}

export interface AdminAccount {
  id: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  isSuperAdmin: boolean;
  createdAt: string;
}

export interface AdminOrg {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  memberCount: number;
}

/**
 * The deployment's defaults of the per-org limits (`GET /admin/orgs`): what an org without an
 * override gets. Sub-agent dispatches and tokens of 0 mean no limit.
 */
export interface LimitDefaults {
  runConcurrency: number;
  sandbox: { cpu: number; memoryMb: number };
  subagents: Required<SubagentLimitOverride>;
}

/** 一个组织的沙箱限额覆盖；未给的项用部署默认，只对之后新建的沙箱生效。 */
export interface SandboxLimitOverride {
  cpu?: number;
  memoryMb?: number;
}

/** One organization's sub-agent limits; values left out use the deployment's `subagents.*`. */
export interface SubagentLimitOverride {
  /** Levels of sub-agents below the root (1: no nesting). */
  maxDepth?: number;
  maxConcurrentPerConversation?: number;
  /** 0: no limit. */
  maxDispatchesPerRun?: number;
  /** 0: no limit. */
  maxTokensPerRun?: number;
}

/** Bounds of the kernel's `SUBAGENT_LIMIT_OVERRIDE` (dispatches and tokens also take 0: no limit). */
export const SUBAGENT_DEPTH = { min: 1, max: 5 } as const;
export const SUBAGENT_CONCURRENT = { min: 1, max: 20 } as const;
export const SUBAGENT_DISPATCHES = { min: 1, max: 500 } as const;
export const SUBAGENT_TOKENS = { min: 10_000, max: Number.MAX_SAFE_INTEGER } as const;

export type CustomPolicy = "allow" | "deny";

/** 部署设置（`GET /admin/settings`）。 */
export interface DeploymentSettings {
  orgCreation: "anyone" | "super_admin";
  runConcurrencyOverrides: Record<string, number>;
  priceCurrency: string;
  sandboxLimitOverrides: Record<string, SandboxLimitOverride>;
  /** Absent from kernels before phase C. */
  subagentLimitOverrides?: Record<string, SubagentLimitOverride>;
  customConnectors: CustomPolicy;
  customSkills: CustomPolicy;
  /** The platform default theme (themes spec §7); `id` null: the built-in theme. */
  uiTheme?: { id: string | null };
  /**
   * The client code kill switch (client extensions spec §10.2): `enabled: false` stops every
   * plugin's client code; `disabled` names the plugins whose client code alone is stopped. Absent
   * from a kernel before client extensions (read as everything on).
   */
  clientExtensions?: ClientExtensionsSetting;
  /**
   * The platform's sandbox levels in effect (kernel `PlatformTiersView`) and where each comes
   * from: `env` / `file` / `nacos` are the startup config (read-only here), `db` the admin
   * console's choice, `default`. Absent from a kernel before the setting.
   */
  sandboxTiers?: PlatformTiersView;
  /**
   * Conversation compaction (context compaction spec §4.8): the platform defaults an organization
   * may override. Absent from a kernel before the setting (read as the built-in defaults).
   */
  compaction?: CompactionSettings;
}

/** Where a platform sandbox level field comes from. */
export type PlatformTierSource = "env" | "file" | "nacos" | "db" | "default";

/** The platform's sandbox levels (`GET /api/v1/admin/settings` `sandboxTiers`). */
export interface PlatformTiersView {
  max: SandboxTier;
  default: SandboxTier;
  allowUnsandboxed: boolean;
  sources: Record<"max" | "default" | "allowUnsandboxed", PlatformTierSource>;
}

/** A change of the platform's sandbox levels: each given field replaces it, null clears it. */
export interface PlatformTiersPatch {
  max?: SandboxTier | null;
  default?: SandboxTier | null;
  allowUnsandboxed?: boolean | null;
}

/** The kill switch as stored (kernel `ClientExtensionsSetting`). */
export interface ClientExtensionsSetting {
  enabled: boolean;
  disabled: string[];
}

/** The kill switch's default: everything on. */
export const CLIENT_EXTENSIONS_DEFAULT: ClientExtensionsSetting = { enabled: true, disabled: [] };

/** `PUT /admin/settings` 的体：只给改动的键；两个覆盖表按组织合并，值为 null 删除该组织的覆盖。 */
export type DeploymentSettingsPatch = Partial<
  Omit<
    DeploymentSettings,
    | "runConcurrencyOverrides"
    | "sandboxLimitOverrides"
    | "subagentLimitOverrides"
    | "clientExtensions"
    | "sandboxTiers"
    | "compaction"
  >
> & {
  subagentLimitOverrides?: Record<string, SubagentLimitOverride | null>;
  runConcurrencyOverrides?: Record<string, number | null>;
  sandboxLimitOverrides?: Record<string, SandboxLimitOverride | null>;
  /** Per slot: the entry replaces the platform default, null removes it. */
  uiArrangement?: Record<string, UiArrangementEntry | null>;
  /** Each given field replaces the stored one (`disabled` is the whole list). */
  clientExtensions?: Partial<ClientExtensionsSetting>;
  sandboxTiers?: PlatformTiersPatch;
  /** Each given field replaces the stored one; fields left out keep their value. */
  compaction?: CompactionSettingsPatch;
};

export interface NewAccountInput {
  login: string;
  password: string;
  displayName: string;
  email?: string;
  superAdmin: boolean;
}

export type AccountPatch = Partial<Pick<AdminAccount, "status" | "isSuperAdmin">>;

/** 沙箱 cpu（核）与内存（MB）的范围，与内核部署设置的校验一致。 */
export const SANDBOX_CPU = { min: 0.25, max: 64 } as const;
export const SANDBOX_MEMORY_MB = { min: 256, max: 262_144 } as const;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

/** One page of accounts. */
export interface AdminAccountsPage {
  accounts: AdminAccount[];
  next: string | null;
}

export const getAdminOverview = () => apiFetch<AdminOverview>("/api/v1/admin/overview");

/** The overview's 待处理 lists (may wait on a provider's model list). */
export const getAdminAttention = () => apiFetch<AdminAttention>("/api/v1/admin/overview/attention");

/** A dead outbox row (`GET /admin/outbox/dead`, kernel `admin/outbox-dead.service.ts`). */
export interface OutboxDeadRow {
  id: string;
  queue: string;
  jobName: string;
  jobId: string;
  /** Null for platform work. */
  orgId: string | null;
  attempts: number;
  lastError: string | null;
  deadAt: string;
  createdAt: string;
}

/** What a retry did: due again, or discarded because the same job is owed already. */
export type OutboxRetryOutcome = "retried" | "already_owed";

/** The dead outbox rows, oldest first (at most 200). */
export const listOutboxDead = () =>
  apiFetch<{ items: OutboxDeadRow[] }>("/api/v1/admin/outbox/dead");

/** Queues a dead outbox row again (or drops it when the same job is owed already). */
export const retryOutboxDead = (id: string) =>
  apiFetch<{ outcome: OutboxRetryOutcome }>(
    `/api/v1/admin/outbox/dead/${encodeURIComponent(id)}/retry`,
    { method: "POST" },
  );

/** Discards a dead outbox row: its job never runs. */
export const discardOutboxDead = (id: string) =>
  apiFetch<void>(`/api/v1/admin/outbox/dead/${encodeURIComponent(id)}`, { method: "DELETE" });

/** The overview's 运行状况 (replicas, queues, connections; polled while the page shows). */
export const getAdminHealth = () => apiFetch<AdminHealth>("/api/v1/admin/overview/health");

/** The overview's 用量: the week in the reader's zone `tz` (`admin.usage_unavailable` 503 on timeout). */
export const getAdminUsage = (tz: string) =>
  apiFetch<AdminUsageWeek>(`/api/v1/admin/overview/usage?tz=${encodeURIComponent(tz)}`);

/**
 * A page of the platform audit log: the newest (`after` omitted) or the one after a cursor. The
 * overview and `/admin/audit` share the first page (limit 20; the overview shows the first 10).
 */
export const listPlatformAudit = (after?: string) =>
  apiFetch<PlatformAuditPage>(
    `/api/v1/admin/audit?limit=20${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
  );

/** 账号分页（按 id 升序）：`next` 为下一页游标，没有更多时为 null。 */
export const listAdminAccounts = (after?: string) =>
  apiFetch<AdminAccountsPage>(
    `/api/v1/admin/accounts?limit=200${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
  );

export const createAdminAccount = (input: NewAccountInput) =>
  apiFetch<{ account: AdminAccount }>("/api/v1/admin/accounts", json("POST", input));

export const updateAdminAccount = (id: string, patch: AccountPatch) =>
  apiFetch<{ account: AdminAccount }>(
    `/api/v1/admin/accounts/${encodeURIComponent(id)}`,
    json("PATCH", patch),
  );

export const listAdminOrgs = () =>
  apiFetch<{ orgs: AdminOrg[]; limitDefaults: LimitDefaults }>("/api/v1/admin/orgs");

export const getDeploymentSettings = () => apiFetch<DeploymentSettings>("/api/v1/admin/settings");

export const updateDeploymentSettings = (patch: DeploymentSettingsPatch) =>
  apiFetch<DeploymentSettings>("/api/v1/admin/settings", json("PUT", patch));

/**
 * 限额输入框的文本 → 值：空白为 null（用部署默认）；不是数字、超出范围或要求整数却不是整数为 "invalid"。
 */
export function parseLimit(
  text: string,
  range: { min: number; max: number },
  integer: boolean,
): number | null | "invalid" {
  const s = text.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < range.min || n > range.max) return "invalid";
  if (integer && !Number.isInteger(n)) return "invalid";
  return n;
}

/** 币种代码：ISO 4217 的三位大写字母。 */
export const isCurrencyCode = (s: string) => /^[A-Z]{3}$/.test(s);
