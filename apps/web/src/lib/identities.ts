import { apiFetch } from "./api";

/** 本人绑定的外部身份（内核 `LinkedIdentity`）。`source` = `<插件名>:<租户 id>`。 */
export interface LinkedIdentity {
  source: string;
  externalId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  /**
   * How the row was made: `bind` (an IM bind link) acts as the person only in IM until a link
   * intent upgrades it; null for rows from before the column.
   */
  linkedVia?: "bind" | "sso" | "directory" | "local" | null;
  createdAt: string;
  /** The platform's name (the identity source's label, else the plugin's display name). */
  label: { zh: string; en: string };
  /** Its plugin provides `channel@1`: the account can talk to agents in IM. */
  channel: boolean;
  /**
   * Sign-in with it: `unsupported` (the plugin has no sign-in), `off` (not offered on this
   * platform), `needs_link` (offered; an IM-bound row that a link intent upgrades), `on`.
   */
  login: "unsupported" | "off" | "needs_link" | "on";
}

/** An enabled login method the account has no identity of (a 绑定 button). */
export interface LinkableMethod {
  plugin: string;
  label: { zh: string; en: string };
}

/**
 * The reason codes a link intent's failure brings back to the linked accounts page
 * (`?error=<code>`); a code outside the set reads `unknown`.
 */
export const LINK_ERROR_CODES = [
  "identity.taken",
  "sso.unavailable",
  "sso.access_denied",
  "sso.provider_error",
  "sso.account_not_allowed",
] as const;
export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number] | "unknown";

/** The `?error=` code of the linked accounts page; null when there is none. */
export function parseLinkError(code: string | undefined): LinkErrorCode | null {
  if (code === undefined || code === "") return null;
  return (LINK_ERROR_CODES as readonly string[]).includes(code)
    ? (code as LinkErrorCode)
    : "unknown";
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
  apiFetch<{ identities: LinkedIdentity[]; linkable: LinkableMethod[] }>("/api/v1/me/identities");

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
