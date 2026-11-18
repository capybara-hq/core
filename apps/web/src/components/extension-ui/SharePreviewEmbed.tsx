"use client";

import { BlockBoundary } from "../conversation/BlockBoundary";
import type { FilePreviewEmbedHost } from "../file-preview/FilePreviewBody";
import { EmbedTab } from "./EmbedTab";

/**
 * An embed previewer on the public share page (file sharing design §6, §7): `EmbedTab` in share
 * mode (a share-scoped token minted by the link's code, `scope: "share"`, no navigation) inside
 * its own `BlockBoundary`. Not an `ExtensionSlot`: the `file.preview` slot belongs to the right
 * panel, and the share page has no org to list contributions from; the previewer comes from the
 * share's metadata.
 */
export function SharePreviewEmbed({ code, host }: { code: string; host: FilePreviewEmbedHost }) {
  const { previewer } = host;
  return (
    <BlockBoundary name={host.title}>
      <EmbedTab
        key={`${previewer.plugin}/${previewer.id}`}
        share={{ code }}
        plugin={previewer.plugin}
        id={previewer.id}
        title={host.title}
        file={{ id: code, maxBytes: previewer.maxBytes, read: host.read }}
        fill
        failed={host.failed}
      />
    </BlockBoundary>
  );
}
