import { apiFetch } from "./api";

/** 本人绑定的外部身份（内核 `LinkedIdentity`）。`source` = `<插件名>:<租户 id>`。 */
export interface LinkedIdentity {
  source: string;
  externalId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

/** 待确认绑定的 IM 身份（内核 `PendingBinding`）。 */
export interface PendingBinding {
  connectionId: string;
  source: string;
  externalId: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

/** 身份源键拆成插件名与租户（`fake-im:t1` → `{ plugin: "fake-im", tenant: "t1" }`）。 */
export function splitSource(source: string): { plugin: string; tenant: string } {
  const i = source.indexOf(":");
  return i < 0
    ? { plugin: source, tenant: "" }
    : { plugin: source.slice(0, i), tenant: source.slice(i + 1) };
}

export const listIdentities = () =>
  apiFetch<{ identities: LinkedIdentity[] }>("/api/v1/me/identities");

export const unlinkIdentity = (source: string, externalId: string) =>
  apiFetch<void>(
    `/api/v1/me/identities/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}`,
    { method: "DELETE" },
  );

const bindPath = (token: string) => `/api/v1/bind/${encodeURIComponent(token)}`;

export const peekBinding = (token: string) =>
  apiFetch<{ binding: PendingBinding }>(bindPath(token));

export const confirmBinding = (token: string) =>
  apiFetch<{ binding: PendingBinding }>(bindPath(token), { method: "POST" });
