"use client";

import { useQueryClient } from "@tanstack/react-query";
import { deleteLibraryFile, uploadLibraryFile } from "../library-files";
import type { UploadedFile } from "../uploads";
import { isConversationFileSharesKey, isConversationFilesKey, keys } from "./keys";
import { useAppMutation } from "./mutation";

// Writes on the person's file library (file library spec §6). Reads: `./library`.

/**
 * Deletes a library file (its shares are revoked with it): the library lists, the usage, the
 * org's share lists, every conversation's file list (the file shows as no longer available
 * there) and every conversation's per-file share lists (the revoked shares) are read again; the file's own reads are forgotten when the caller leaves.
 */
export function useDeleteLibraryFile(orgId: string) {
  const qc = useQueryClient();
  return useAppMutation<{ fileId: string }, void>({
    fn: async (v) => {
      await deleteLibraryFile(orgId, v.fileId);
      // No common prefix holds every conversation's file and share lists alone: match them.
      await qc.invalidateQueries({
        predicate: (q) =>
          isConversationFilesKey(orgId, q.queryKey) ||
          isConversationFileSharesKey(orgId, q.queryKey),
      });
    },
    invalidates: () => [
      keys.org(orgId).filesAll(),
      keys.org(orgId).fileUsage(),
      keys.org(orgId).sharesAll(),
    ],
    forgetsOnLeave: (v) => [keys.org(orgId).file(v.fileId)],
  });
}

/** Uploads a file into the library (ready at once): the lists and the usage are read again. */
export function useUploadLibraryFile(orgId: string) {
  return useAppMutation<
    { file: File; onProgress?: (fraction: number) => void; signal?: AbortSignal },
    UploadedFile
  >({
    fn: (v) =>
      uploadLibraryFile(orgId, v.file, {
        ...(v.onProgress !== undefined && { onProgress: v.onProgress }),
        ...(v.signal !== undefined && { signal: v.signal }),
      }),
    invalidates: () => [keys.org(orgId).filesAll(), keys.org(orgId).fileUsage()],
  });
}
