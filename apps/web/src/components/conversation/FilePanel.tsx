"use client";

import { FileCard, FilePreviewFrame, formatRelative, typeBadge, useNow } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { sourceUrls } from "../../lib/file-source";
import type { FileOutput } from "../../lib/files";
import { uiLocale } from "../../lib/ui";
import { ExtensionSlot } from "../extension-ui/ExtensionSlot";
import { FilePreviewBody } from "../file-preview/FilePreviewBody";
import { ShareDialog } from "../file-preview/ShareDialog";
import { useOpenDownload } from "../SessionFilePreview";

/**
 * A file output in the right panel (spec §5.8, design `FilePreviewFrame`): the header switches
 * between the conversation's files and, when more than one applies, previewers; Share opens the
 * share dialog (file sharing design §5). The body is {@link FilePreviewBody}, the same one the
 * share page renders; a removed file shows the removed card.
 */
export function FilePanel({
  orgId,
  conversationId,
  file,
  files,
  onSwitch,
  onClose,
  onFullscreen,
}: {
  orgId: string;
  conversationId: string;
  file: FileOutput;
  files: FileOutput[];
  onSwitch(id: string): void;
  onClose(): void;
  onFullscreen(): void;
}) {
  const t = useTranslations("chat");
  const locale = uiLocale(useLocale());
  const now = useNow();
  const openDownload = useOpenDownload();
  const [picked, setPicked] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const source = { kind: "conversation" as const, orgId, conversationId, file };
  const download = () => openDownload(sourceUrls(source).download);
  const available = file.status !== "removed";

  const header = {
    badge: typeBadge(file.name, file.contentType),
    name: file.name,
    version: `v${file.version} · ${formatRelative(file.versions[0]?.createdAt ?? file.createdAt, locale, now)}`,
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      ...(f.origin === "uploaded" ? { uploaded: true } : {}),
    })),
    current: file.id,
    onSwitch,
    onPreviewer: setPicked,
    ...(available ? { onShare: () => setSharing(true), shared: file.shared === true } : {}),
    onDownload: download,
    onFullscreen,
    onClose,
  };

  if (!available) {
    return (
      <FilePreviewFrame header={header} state="ready">
        <FileCard
          name={file.name}
          contentType={file.contentType}
          size={file.size}
          removed={{ reason: t("fileRemoved") }}
        />
      </FilePreviewFrame>
    );
  }
  return (
    <>
      <FilePreviewBody
        source={source}
        previewer={picked}
        onDownload={download}
        embed={(h) => (
          <ExtensionSlot
            key={`${h.previewer.plugin}/${h.previewer.id}/${file.id}`}
            slot="file.preview"
            args={{ orgId, conversationId, fileId: file.id }}
            select={{ plugin: h.previewer.plugin, id: h.previewer.id }}
            host={{
              title: h.title,
              maxBytes: h.previewer.maxBytes,
              read: h.read,
              failed: h.failed,
            }}
          />
        )}
        frame={({ previewers, previewer, ...f }) => (
          <FilePreviewFrame
            header={{ ...header, previewers, ...(previewer !== undefined ? { previewer } : {}) }}
            {...f}
          />
        )}
      />
      <ShareDialog
        orgId={orgId}
        conversationId={conversationId}
        file={file}
        open={sharing}
        onOpenChange={setSharing}
      />
    </>
  );
}
