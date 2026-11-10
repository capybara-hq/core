import type { ExtensionStatus } from "./admin-extensions";
import { apiFetch } from "./api";
import type { LocalizedName } from "./catalog";
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
   * model providers of {@link AdminAttention} (counted in full, not capped).
   */
  attentionTotal: number;
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
export type AttentionSource = "extensions" | "updates" | "providers";

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
}

export interface AttentionProvider {
  /** The provider's plugin name. */
  plugin: string;
  displayName: LocalizedName | null;
  icon: string | null;
  problem: AttentionProviderProblem;
}

/**
 * `GET /admin/overview/attention`: what needs a super admin besides the inbox, each list capped
 * (the rest counted in `more`); `unavailable` names the lists the kernel could not read.
 */
export interface AdminAttention {
  extensions: AttentionExtension[];
  updates: AttentionUpdate[];
  providers: AttentionProvider[];
  more: Record<AttentionSource, number>;
  unavailable: AttentionSource[];
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
  >
> & {
  subagentLimitOverrides?: Record<string, SubagentLimitOverride | null>;
  runConcurrencyOverrides?: Record<string, number | null>;
  sandboxLimitOverrides?: Record<string, SandboxLimitOverride | null>;
  /** Per slot: the entry replaces the platform default, null removes it. */
  uiArrangement?: Record<string, UiArrangementEntry | null>;
  /** Each given field replaces the stored one (`disabled` is the whole list). */
  clientExtensions?: Partial<ClientExtensionsSetting>;
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

/** A page of the platform audit log: the newest (`after` omitted) or the one after a cursor. */
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
