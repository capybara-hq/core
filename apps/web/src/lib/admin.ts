import { apiFetch } from "./api";

/**
 * 企业管理员后台（`/api/v1/admin/*`，内核 `admin/admin.controller.ts`）。只有企业管理员能调用，
 * 界面上的隐藏只是方便，最终由内核判定。
 */

/** 后台概览的四个数字（`GET /admin/overview`）。 */
export interface AdminOverview {
  /** 需要处理的插件：待批准、待配置、失败、依赖缺失、副本不一致。 */
  extensionsNeedingAction: number;
  /** 待处理的企业目录申请（目录申请上线前恒为 0）。 */
  catalogRequestsPending: number;
  orgs: number;
  accounts: number;
}

export interface AdminAccount {
  id: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  isEnterpriseAdmin: boolean;
  createdAt: string;
}

export interface AdminOrg {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  memberCount: number;
}

/** 一个组织的沙箱限额覆盖；未给的项用部署默认，只对之后新建的沙箱生效。 */
export interface SandboxLimitOverride {
  cpu?: number;
  memoryMb?: number;
}

export type CustomPolicy = "allow" | "deny";

/** 部署设置（`GET /admin/settings`）。 */
export interface DeploymentSettings {
  orgCreation: "anyone" | "enterprise_admin";
  runConcurrencyOverrides: Record<string, number>;
  priceCurrency: string;
  sandboxLimitOverrides: Record<string, SandboxLimitOverride>;
  customConnectors: CustomPolicy;
  customSkills: CustomPolicy;
}

/** `PUT /admin/settings` 的体：只给改动的键；两个覆盖表按组织合并，值为 null 删除该组织的覆盖。 */
export type DeploymentSettingsPatch = Partial<
  Omit<DeploymentSettings, "runConcurrencyOverrides" | "sandboxLimitOverrides">
> & {
  runConcurrencyOverrides?: Record<string, number | null>;
  sandboxLimitOverrides?: Record<string, SandboxLimitOverride | null>;
};

export interface NewAccountInput {
  login: string;
  password: string;
  displayName: string;
  email?: string;
  enterpriseAdmin: boolean;
}

export type AccountPatch = Partial<Pick<AdminAccount, "status" | "isEnterpriseAdmin">>;

/** 沙箱 cpu（核）与内存（MB）的范围，与内核部署设置的校验一致。 */
export const SANDBOX_CPU = { min: 0.25, max: 64 } as const;
export const SANDBOX_MEMORY_MB = { min: 256, max: 262_144 } as const;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const getAdminOverview = () => apiFetch<AdminOverview>("/api/v1/admin/overview");

/** 账号分页（按 id 升序）：`next` 为下一页游标，没有更多时为 null。 */
export const listAdminAccounts = (after?: string) =>
  apiFetch<{ accounts: AdminAccount[]; next: string | null }>(
    `/api/v1/admin/accounts?limit=200${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
  );

export const createAdminAccount = (input: NewAccountInput) =>
  apiFetch<{ account: AdminAccount }>("/api/v1/admin/accounts", json("POST", input));

export const updateAdminAccount = (id: string, patch: AccountPatch) =>
  apiFetch<{ account: AdminAccount }>(
    `/api/v1/admin/accounts/${encodeURIComponent(id)}`,
    json("PATCH", patch),
  );

export const listAdminOrgs = () => apiFetch<{ orgs: AdminOrg[] }>("/api/v1/admin/orgs");

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
