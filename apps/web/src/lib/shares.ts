import { apiFetch } from "./api";
import { type ShareMeta, shareBase } from "./file-source";
import { readTextPreview, TEXT_PREVIEW_BYTES } from "./files";
import type { UiLocale, UiView } from "./ui";

/**
 * File shares (kernel `shares/`, file sharing design §2, §3): a share is a snapshot of one
 * conversation file behind `/s/<code>`. The owner creates, refreshes and revokes them from the
 * right panel; org admins and members list them in settings; anyone with a live link reads the
 * public `/api/v1/s/<code>` routes.
 */

/** `suspended`: an external share while external sharing is off, or its creator lost access. */
export type ShareState = "live" | "expired" | "revoked" | "suspended";

export interface ShareView {
  id: string;
  code: string;
  audience: "internal" | "external";
  conversationId: string;
  fileId: string;
  sourcePath: string | null;
  name: string;
  contentType: string;
  size: number;
  generation: number;
  createdBy: { id: string; displayName: string };
  createdAt: string;
  expiresAt: string | null;
  lastOpenedAt: string | null;
  state: ShareState;
  revokedAt: string | null;
  revokeReason: string | null;
  /** A newer available version of `sourcePath` exists (Update to latest is offered). */
  newerVersion: boolean;
}

/** Whether external sharing is allowed for the org, and the platform's expiry maximum. */
export interface SharePolicy {
  external: "allowed" | "platform_denied" | "org_off";
  maxExpiryDays: number;
}

export type ShareExpiry = 1 | 7 | 30 | null;

/** The expiry choices (days; `null` = never, internal shares only). */
export const SHARE_EXPIRIES: readonly ShareExpiry[] = [1, 7, 30, null];

const enc = encodeURIComponent;
const orgBase = (orgId: string) => `/api/v1/orgs/${enc(orgId)}`;
const fileShares = (orgId: string, conversationId: string, fileId: string) =>
  `${orgBase(orgId)}/conversations/${enc(conversationId)}/files/${enc(fileId)}/shares`;

/** The link people open: `<origin>/s/<code>`. */
export const shareLink = (origin: string, code: string) => `${origin}/s/${code}`;

export const listFileShares = (orgId: string, conversationId: string, fileId: string) =>
  apiFetch<{ shares: ShareView[]; policy: SharePolicy }>(fileShares(orgId, conversationId, fileId));

export const createShare = (
  orgId: string,
  conversationId: string,
  fileId: string,
  body: { audience: "internal" | "external"; expiresInDays: ShareExpiry },
) =>
  apiFetch<{ share: ShareView }>(fileShares(orgId, conversationId, fileId), {
    method: "POST",
    body: JSON.stringify(body),
  });

export const refreshShare = (orgId: string, shareId: string) =>
  apiFetch<{ share: ShareView }>(`${orgBase(orgId)}/shares/${enc(shareId)}/refresh`, {
    method: "POST",
  });

export const revokeShare = (orgId: string, shareId: string) =>
  apiFetch<void>(`${orgBase(orgId)}/shares/${enc(shareId)}`, { method: "DELETE" });

export const listOrgShares = (orgId: string, scope: "mine" | "all") =>
  apiFetch<{ shares: ShareView[] }>(`${orgBase(orgId)}/shares?scope=${scope}`);

// ── Public share routes ─────────────────────────────────────────────────────

/** A share's metadata; 404 `share.not_found`, 401 `share.sign_in_required` (internal). */
export const getShareMeta = (code: string) => apiFetch<ShareMeta>(shareBase(code));

/** The first bytes of a share's text for the built-in previews; `truncated` when cut. */
export const shareText = (code: string, signal?: AbortSignal) =>
  readTextPreview(`${shareBase(code)}/text?limit=${TEXT_PREVIEW_BYTES}`, signal);

/** A view previewer rendered by the kernel for the share's snapshot. */
export const renderSharePreview = (
  code: string,
  p: { plugin: string; id: string },
  locale: UiLocale,
) =>
  apiFetch<{ view: UiView }>(
    `${shareBase(code)}/previews/${enc(p.plugin)}/${enc(p.id)}?locale=${locale}`,
  );
