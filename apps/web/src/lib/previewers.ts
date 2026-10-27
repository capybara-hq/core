import { apiFetch } from "./api";
import type { UiLocale, UiView } from "./ui";

/**
 * `file-preview@1` (kernel `files/previewers.controller.ts`): the extension previewers that take a
 * file of a conversation, a view previewer's render, and the org's previewer order (admins).
 * Built-in previewers (image, text, Markdown, CSV / TSV) live in the web (UI refresh B Task 16).
 */

/** A previewer that takes a file, in the org's order. */
export interface FilePreviewerItem {
  plugin: string;
  id: string;
  title: { zh: string; en: string };
  kind: "view" | "embed";
  /** The most bytes it takes: pass it to the embed bridge as `fileMaxBytes`. */
  maxBytes: number;
}

/** A previewer in the org's order (admin list). */
export interface OrgFilePreviewer extends FilePreviewerItem {
  accepts: { mimeTypes?: string[]; extensions?: string[] };
  position: number;
  disabled: boolean;
}

const enc = encodeURIComponent;
const fileBase = (orgId: string, conversationId: string, fileId: string) =>
  `/api/v1/orgs/${enc(orgId)}/conversations/${enc(conversationId)}/files/${enc(fileId)}`;

export const listFilePreviewers = (orgId: string, conversationId: string, fileId: string) =>
  apiFetch<{ previewers: FilePreviewerItem[] }>(
    `${fileBase(orgId, conversationId, fileId)}/previewers`,
  );

export const renderFilePreview = (
  orgId: string,
  conversationId: string,
  fileId: string,
  p: { plugin: string; id: string },
  locale: UiLocale,
) =>
  apiFetch<{ view: UiView }>(
    `${fileBase(orgId, conversationId, fileId)}/previews/${enc(p.plugin)}/${enc(p.id)}?locale=${locale}`,
  );

export const getOrgFilePreviewers = (orgId: string) =>
  apiFetch<{ items: OrgFilePreviewer[] }>(`/api/v1/orgs/${enc(orgId)}/file-previewers`);

export const putOrgFilePreviewers = (
  orgId: string,
  items: { plugin: string; id: string; disabled: boolean }[],
) =>
  apiFetch<{ items: OrgFilePreviewer[] }>(`/api/v1/orgs/${enc(orgId)}/file-previewers`, {
    method: "PUT",
    body: JSON.stringify({ items }),
  });

/** Moves item `i` by `delta` (−1 up, +1 down); returns the PUT body for the new order. */
export function reorder(
  items: OrgFilePreviewer[],
  i: number,
  delta: -1 | 1,
): { plugin: string; id: string; disabled: boolean }[] {
  const next = [...items];
  const j = i + delta;
  if (j >= 0 && j < next.length) {
    const a = next[i] as OrgFilePreviewer;
    next[i] = next[j] as OrgFilePreviewer;
    next[j] = a;
  }
  return next.map((p) => ({ plugin: p.plugin, id: p.id, disabled: p.disabled }));
}
