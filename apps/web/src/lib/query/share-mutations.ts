"use client";

import {
  createShare,
  refreshShare,
  revokeShare,
  type ShareExpiry,
  type ShareView,
} from "../shares";
import { keys } from "./keys";
import { useAppMutation } from "./mutation";

// The owner's and org admins' writes on file shares (file sharing design §2). Each invalidates the
// conversation's per-file share lists, the org's share lists and the conversation's files (their
// `shared` marker).

/** What a share write makes stale: the file's shares, the org's lists, the files' markers. */
const shareKeys = (orgId: string, conversationId: string): (readonly unknown[])[] => {
  const c = keys.org(orgId).conversation(conversationId);
  return [c.fileSharesAll(), c.files(), keys.org(orgId).sharesAll()];
};

/** Shares one file version: `POST …/files/:fileId/shares`. */
export function useCreateShare(orgId: string, conversationId: string, fileId: string) {
  return useAppMutation<
    { audience: "internal" | "external"; expiresInDays: ShareExpiry },
    { share: ShareView }
  >({
    fn: (body) => createShare(orgId, conversationId, fileId, body),
    invalidates: () => shareKeys(orgId, conversationId),
  });
}

/** Update to latest: copies the newest available version under the same link. */
export function useRefreshShare(orgId: string) {
  return useAppMutation<{ shareId: string; conversationId: string }, { share: ShareView }>({
    fn: (v) => refreshShare(orgId, v.shareId),
    invalidates: (v) => shareKeys(orgId, v.conversationId),
  });
}

/** Revokes a share (its creator, or an org admin). */
export function useRevokeShare(orgId: string) {
  return useAppMutation<{ shareId: string; conversationId: string }, void>({
    fn: (v) => revokeShare(orgId, v.shareId),
    invalidates: (v) => shareKeys(orgId, v.conversationId),
  });
}
