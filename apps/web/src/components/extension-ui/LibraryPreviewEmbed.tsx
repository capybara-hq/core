"use client";

import { BlockBoundary } from "../conversation/BlockBoundary";
import type { FilePreviewEmbedHost } from "../file-preview/FilePreviewBody";
import { EmbedTab } from "./EmbedTab";

/**
 * An embed previewer of one of the person's library files (file library spec §6, the Files page):
 * `EmbedTab` with the org's token minted for `{ fileId }` alone (no conversation) inside its own
 * `BlockBoundary`. Not an `ExtensionSlot`: the `file.preview` slot is the right panel's and names
 * a conversation's file; the previewer comes from the library file's previewer list.
 */
export function LibraryPreviewEmbed({
  orgId,
  fileId,
  host,
}: {
  orgId: string;
  fileId: string;
  host: FilePreviewEmbedHost;
}) {
  const { previewer } = host;
  return (
    <BlockBoundary name={host.title}>
      <EmbedTab
        key={`${previewer.plugin}/${previewer.id}/${fileId}`}
        orgId={orgId}
        plugin={previewer.plugin}
        id={previewer.id}
        title={host.title}
        file={{ id: fileId, maxBytes: previewer.maxBytes, read: host.read }}
        fill
        failed={host.failed}
      />
    </BlockBoundary>
  );
}
