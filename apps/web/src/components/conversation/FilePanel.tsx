"use client";

import {
  CsvPreview,
  FileCard,
  FilePreviewFrame,
  formatRelative,
  ImagePreview,
  LoadFailed,
  MarkdownPreview,
  NoPreview,
  TextPreview,
  typeBadge,
  useNow,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ApiClientError } from "../../lib/api";
import { artifactDownloadUrl } from "../../lib/artifacts";
import { builtinPreview, type FileOutput } from "../../lib/files";
import type { FilePreviewerItem } from "../../lib/previewers";
import { filePreviewersQuery, filePreviewQuery, fileTextQuery } from "../../lib/query/conversation";
import { type UiView, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { EmbedTab } from "../extension-ui/EmbedTab";
import { useOpenDownload } from "../SessionFilePreview";
import { UiViewRenderer } from "../ui-view/UiViewRenderer";

type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; e: unknown };

const BUILTIN = "builtin";
const previewerId = (p: FilePreviewerItem) => `${p.plugin}/${p.id}`;

/**
 * A file output in the right panel (spec §5.8, design `FilePreviewFrame`): the header switches
 * between the conversation's files and, when more than one applies, previewers. An extension
 * previewer that accepts the file wins over the built-in one (decision 7); built-ins show bitmaps
 * (`?inline=1`), text and code, Markdown and CSV / TSV; anything else shows the file card with
 * Download. A failing previewer shows Retry with the Download fallback, in this panel only.
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
  const errorMessage = useErrorMessage();
  const openDownload = useOpenDownload();
  const [picked, setPicked] = useState<string | null>(null);
  const builtin = file.status === "removed" ? null : builtinPreview(file);
  const download = () => openDownload(artifactDownloadUrl(orgId, conversationId, file.id));

  // No extension previewers readable: the built-in one (or the file card) shows.
  const previewers = useQuery({
    ...filePreviewersQuery(orgId, conversationId, file.id),
    enabled: file.status !== "removed",
    retry: false,
  });
  const extensions: FilePreviewerItem[] | null =
    file.status === "removed"
      ? []
      : previewers.data !== undefined
        ? previewers.data
        : previewers.error !== null
          ? []
          : null;

  const options = [
    ...(extensions ?? []).map((p) => ({ id: previewerId(p), title: p.title[locale], p })),
    ...(builtin !== null ? [{ id: BUILTIN, title: t("builtinPreviewer"), p: null }] : []),
  ];
  const current = options.find((o) => o.id === picked) ?? options[0];

  // The body of the current previewer: an extension's rendered view, an embed (it loads itself),
  // a bitmap (`?inline=1`, nothing to read) or the file's text for the other built-ins.
  const p = current?.p ?? null;
  const viewP = p !== null && p.kind === "view" ? p : null;
  const viewQ = useQuery({
    ...filePreviewQuery(orgId, conversationId, file.id, viewP ?? { plugin: "", id: "" }, locale),
    enabled: extensions !== null && viewP !== null,
    retry: false,
  });
  const textQ = useQuery({
    ...fileTextQuery(orgId, conversationId, file.id),
    enabled: extensions !== null && current !== undefined && p === null && builtin !== "image",
    retry: false,
  });
  const body: Load<{ text?: string; truncated?: boolean; view?: UiView }> =
    extensions === null || current === undefined
      ? { kind: "loading" }
      : p !== null
        ? p.kind !== "view"
          ? { kind: "ready", data: {} }
          : viewQ.data !== undefined
            ? { kind: "ready", data: { view: viewQ.data } }
            : viewQ.error !== null
              ? { kind: "error", e: viewQ.error }
              : { kind: "loading" }
        : builtin === "image"
          ? { kind: "ready", data: {} }
          : textQ.data !== undefined
            ? { kind: "ready", data: textQ.data }
            : textQ.error !== null
              ? { kind: "error", e: textQ.error }
              : { kind: "loading" };
  const retryBody = () => void (viewP !== null ? viewQ.refetch() : textQ.refetch());

  const header = {
    badge: typeBadge(file.name, file.contentType),
    name: file.name,
    version: `v${file.version} · ${formatRelative(file.versions[0]?.createdAt ?? file.createdAt, locale, now)}`,
    files: files.map((f) => ({ id: f.id, name: f.name })),
    current: file.id,
    onSwitch,
    previewers: options.map((o) => ({ id: o.id, title: o.title })),
    ...(current ? { previewer: current.id } : {}),
    onPreviewer: setPicked,
    onDownload: download,
    onFullscreen,
    onClose,
  };
  const fallback = (
    <NoPreview
      name={file.name}
      contentType={file.contentType}
      size={file.size}
      hint={false}
      onDownload={download}
    />
  );

  if (file.status === "removed") {
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
  if (extensions !== null && !current) {
    return (
      <FilePreviewFrame header={header} state="ready">
        <NoPreview
          name={file.name}
          contentType={file.contentType}
          size={file.size}
          onDownload={download}
        />
      </FilePreviewFrame>
    );
  }
  if (extensions === null || !current || body.kind === "loading") {
    return <FilePreviewFrame header={header} state="loading" />;
  }
  if (body.kind === "error") {
    const code = body.e instanceof ApiClientError ? body.e.code : "unknown";
    return (
      <FilePreviewFrame
        header={header}
        state="failed"
        failure={{ name: current.title, reason: errorMessage(new ApiClientError(0, code, code)) }}
        onRetry={retryBody}
      >
        {fallback}
      </FilePreviewFrame>
    );
  }
  let content: ReactNode = null;
  const data = body.data;
  if (current.p?.kind === "embed") {
    const p = current.p;
    content = (
      <EmbedTab
        key={`${previewerId(p)}/${file.id}`}
        orgId={orgId}
        plugin={p.plugin}
        id={p.id}
        title={current.title}
        conversationId={conversationId}
        file={{
          id: file.id,
          maxBytes: p.maxBytes,
          read: async () => {
            const res = await fetch(artifactDownloadUrl(orgId, conversationId, file.id), {
              credentials: "same-origin",
            });
            if (!res.ok) throw new ApiClientError(res.status, "http_error", "download failed");
            return {
              name: file.name,
              contentType: file.contentType,
              size: file.size,
              data: await res.arrayBuffer(),
            };
          },
        }}
        failed={({ message, onRetry }) => (
          <>
            <LoadFailed name={current.title} reason={message} onRetry={onRetry} />
            {fallback}
          </>
        )}
      />
    );
  } else if (current.p?.kind === "view" && data.view) {
    content = <UiViewRenderer view={data.view} onAction={async () => {}} />;
  } else if (builtin === "image") {
    content = (
      <ImagePreview
        src={artifactDownloadUrl(orgId, conversationId, file.id, { inline: true })}
        name={file.name}
      />
    );
  } else if (builtin === "markdown") {
    content = <MarkdownPreview text={data.text ?? ""} />;
  } else if (builtin === "csv" || builtin === "tsv") {
    content = <CsvPreview text={data.text ?? ""} delimiter={builtin === "csv" ? "," : "\t"} />;
  } else {
    content = <TextPreview text={data.text ?? ""} truncated={data.truncated === true} />;
  }
  return (
    <FilePreviewFrame header={header} state="ready">
      {content}
    </FilePreviewFrame>
  );
}
