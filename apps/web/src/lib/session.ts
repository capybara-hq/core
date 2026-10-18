import { apiFetch } from "./api";

/** 内核 `GET /api/v1/me` 的响应（只声明界面用到的字段）。 */
export interface Account {
  id: string;
  displayName: string;
  email: string | null;
  isEnterpriseAdmin: boolean;
}

export interface Membership {
  orgId: string;
  slug: string;
  name: string;
  role: string;
}

export interface Me {
  account: Account;
  via: "session" | "pat";
  currentOrgId: string | null;
  memberships: Membership[];
}

export interface SetupInput {
  login: string;
  password: string;
  displayName: string;
  orgName?: string;
  setupToken?: string;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** 本地登录；成功后内核通过代理设置会话 Cookie。 */
export const login = (loginName: string, password: string) =>
  apiFetch<{ account: Account }>("/api/v1/auth/login", post({ login: loginName, password }));

export const logout = () => apiFetch<void>("/api/v1/auth/logout", { method: "POST" });

export const getMe = () => apiFetch<Me>("/api/v1/me");

/** 切换当前组织（仅 Web 会话）。 */
export const setCurrentOrg = (orgId: string | null) =>
  apiFetch<void>("/api/v1/me/current-org", { method: "PUT", body: JSON.stringify({ orgId }) });

export const getSetupStatus = () => apiFetch<{ needsSetup: boolean }>("/api/v1/setup");

/** 完成初始化向导；成功后内核直接登录（设会话 Cookie）。 */
export const completeSetup = (input: SetupInput) =>
  apiFetch<{ account: Account }>("/api/v1/setup", post(input));
