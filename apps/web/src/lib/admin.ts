import { apiFetch } from "./api";
import type { UiArrangementEntry } from "./ui";

/**
 * 超级管理员后台（`/api/v1/admin/*`，内核 `admin/admin.controller.ts`）。只有超级管理员能调用，
 * 界面上的隐藏只是方便，最终由内核判定。
 */

/** 后台概览的四个数字（`GET /admin/overview`）。 */
export interface AdminOverview {
  /** 需要处理的插件：待批准、待配置、失败、依赖缺失、副本不一致。 */
  extensionsNeedingAction: number;
  /** 待处理的平台目录申请（目录申请上线前恒为 0）。 */
  catalogRequestsPending: number;
  orgs: number;
  accounts: number;
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
}

/** `PUT /admin/settings` 的体：只给改动的键；两个覆盖表按组织合并，值为 null 删除该组织的覆盖。 */
export type DeploymentSettingsPatch = Partial<
  Omit<
    DeploymentSettings,
    "runConcurrencyOverrides" | "sandboxLimitOverrides" | "subagentLimitOverrides"
  >
> & {
  subagentLimitOverrides?: Record<string, SubagentLimitOverride | null>;
  runConcurrencyOverrides?: Record<string, number | null>;
  sandboxLimitOverrides?: Record<string, SandboxLimitOverride | null>;
  /** Per slot: the entry replaces the platform default, null removes it. */
  uiArrangement?: Record<string, UiArrangementEntry | null>;
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
