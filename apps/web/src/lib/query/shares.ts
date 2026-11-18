import {
  getShareMeta,
  listFileShares,
  listOrgShares,
  renderSharePreview,
  shareText,
} from "../shares";
import type { UiLocale } from "../ui";
import { defineQuery } from "./define";
import { keys } from "./keys";

// File shares (file sharing design §2, §3): the owner's per-file list in the right panel, the
// settings lists, and the public share page's reads. Writes: `./share-mutations`.

/** A file's shares (every version of its source path) and the org's share policy. */
export const fileSharesQuery = (orgId: string, conversationId: string, fileId: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(conversationId).fileShares(fileId),
    fn: () => listFileShares(orgId, conversationId, fileId),
    freshness: "live",
  });

/** The org's shares: the person's own, or every one (org admins). */
export const orgSharesQuery = (orgId: string, scope: "mine" | "all") =>
  defineQuery({
    key: keys.org(orgId).shares(scope),
    fn: () => listOrgShares(orgId, scope).then((r) => r.shares),
    freshness: "live",
  });

/** A share link's metadata (public; an internal link needs a member's session). */
export const shareMetaQuery = (code: string) =>
  defineQuery({
    key: keys.share(code).meta(),
    fn: () => getShareMeta(code),
    freshness: "live",
  });

/** A share's text for the built-in previews (the first bytes; `truncated` past them). */
export const shareTextQuery = (code: string) =>
  defineQuery({
    key: keys.share(code).text(),
    fn: ({ signal }) => shareText(code, signal),
    freshness: "live",
  });

/** A view previewer's render of a share's snapshot. */
export const shareViewQuery = (code: string, p: { plugin: string; id: string }, locale: UiLocale) =>
  defineQuery({
    key: keys.share(code).view(`${p.plugin}/${p.id}`, locale),
    fn: () => renderSharePreview(code, p, locale).then((r) => r.view),
    freshness: "live",
  });
