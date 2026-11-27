"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  createLibraryShare,
  createShare,
  refreshShare,
  revokeShare,
  type ShareExpiry,
  type ShareView,
} from "../shares";
import { isConversationFilesKey, keys } from "./keys";
import { useAppMutation } from "./mutation";

// The owner's and org admins' writes on file shares (file sharing design §2, file library spec
// §6). Each invalidates the file's share lists, the org's share lists (a library file's shares live
// under them) and the files' `shared` marker: the conversation's, or for a library file's share
// (no conversation) every conversation's file list, since the file may be listed in any of them.

/** What a share write makes stale: the file's shares, the org's lists, the files' markers. */
const shareKeys = (orgId: string, conversationId: string | null): (readonly unknown[])[] => {
  if (conversationId === null) return [keys.org(orgId).sharesAll()];
  const c = keys.org(orgId).conversation(conversationId);
  return [c.fileSharesAll(), c.files(), keys.org(orgId).sharesAll()];
};

/** A library share's markers: every conversation's file list of the org. */
const conversationFiles = (qc: QueryClient, orgId: string, conversationId: string | null) =>
  conversationId === null
    ? qc.invalidateQueries({ predicate: (q) => isConversationFilesKey(orgId, q.queryKey) })
    : Promise.resolve();

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

/** Shares one of the caller's library files: `POST …/files/:fileId/shares`. */
export function useCreateLibraryShare(orgId: string, fileId: string) {
  const qc = useQueryClient();
  return useAppMutation<
    { audience: "internal" | "external"; expiresInDays: ShareExpiry },
    { share: ShareView }
  >({
    fn: async (body) => {
      const r = await createLibraryShare(orgId, fileId, body);
      await conversationFiles(qc, orgId, null);
      return r;
    },
    invalidates: () => shareKeys(orgId, null),
  });
}

/** Update to latest: copies the newest available version under the same link. */
export function useRefreshShare(orgId: string) {
  const qc = useQueryClient();
  return useAppMutation<{ shareId: string; conversationId: string | null }, { share: ShareView }>({
    fn: async (v) => {
      const r = await refreshShare(orgId, v.shareId);
      await conversationFiles(qc, orgId, v.conversationId);
      return r;
    },
    invalidates: (v) => shareKeys(orgId, v.conversationId),
  });
}

/** Revokes a share (its creator, or an org admin). */
export function useRevokeShare(orgId: string) {
  const qc = useQueryClient();
  return useAppMutation<{ shareId: string; conversationId: string | null }, void>({
    fn: async (v) => {
      await revokeShare(orgId, v.shareId);
      await conversationFiles(qc, orgId, v.conversationId);
    },
    invalidates: (v) => shareKeys(orgId, v.conversationId),
  });
}
