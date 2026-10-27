"use client";

import {
  CsvPreview,
  FileCard,
  FilePreviewFrame,
  ImagePreview,
  LoadFailed,
  MarkdownPreview,
  NoPreview,
  TextPreview,
  typeBadge,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { ApiClientError } from "../../lib/api";
import { artifactDownloadUrl } from "../../lib/artifacts";
import { builtinPreview, type FileOutput, fileText } from "../../lib/files";
import {
  type FilePreviewerItem,
  listFilePreviewers,
  renderFilePreview,
} from "../../lib/previewers";
import { type UiView, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { EmbedTab } from "../extension-ui/EmbedTab";
import { useOpenDownload } from "../SessionFilePreview";
import { UiViewRenderer } from "../ui-view/UiViewRenderer";

type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; e: unknown };

const BUILTIN = "builtin";
const previewerId = (p: FilePreviewerItem) => `${p.plugin}/${p.id}`;

/** The relative age of a version ("刚刚", "5 分钟前") for the header's "v2 · …". */
function ago(iso: string, locale: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  if (s < 60) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  return rtf.format(-Math.floor(s / 86400), "day");
}

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
  const errorMessage = useErrorMessage();
  const openDownload = useOpenDownload();
  const [extensions, setExtensions] = useState<FilePreviewerItem[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [body, setBody] = useState<Load<{ text?: string; truncated?: boolean; view?: UiView }>>({
    kind: "loading",
  });
  const builtin = file.status === "removed" ? null : builtinPreview(file);
  const download = () => openDownload(artifactDownloadUrl(orgId, conversationId, file.id));

  useEffect(() => {
    let live = true;
    setExtensions(null);
    setPicked(null);
    if (file.status === "removed") {
      setExtensions([]);
      return;
    }
    listFilePreviewers(orgId, conversationId, file.id).then(
      (r) => {
        if (live) setExtensions(r.previewers);
      },
      () => {
        // No extension previewers readable: the built-in one (or the file card) shows.
        if (live) setExtensions([]);
      },
    );
    return () => {
      live = false;
    };
  }, [orgId, conversationId, file.id, file.status]);

  const options = [
    ...(extensions ?? []).map((p) => ({ id: previewerId(p), title: p.title[locale], p })),
    ...(builtin !== null ? [{ id: BUILTIN, title: t("builtinPreviewer"), p: null }] : []),
  ];
  const current = options.find((o) => o.id === picked) ?? options[0];

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs a failed load
  useEffect(() => {
    if (extensions === null || !current) return;
    const ctrl = new AbortController();
    let live = true;
    const done = (b: typeof body) => {
      if (live) setBody(b);
    };
    setBody({ kind: "loading" });
    if (current.p !== null) {
      if (current.p.kind === "view") {
        renderFilePreview(orgId, conversationId, file.id, current.p, locale).then(
          ({ view }) => done({ kind: "ready", data: { view } }),
          (e: unknown) => done({ kind: "error", e }),
        );
      } else done({ kind: "ready", data: {} });
    } else if (builtin === "image") {
      done({ kind: "ready", data: {} });
    } else {
      fileText(orgId, conversationId, file.id, ctrl.signal).then(
        (r) => done({ kind: "ready", data: r }),
        (e: unknown) => done({ kind: "error", e }),
      );
    }
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [orgId, conversationId, file.id, extensions, current?.id, builtin, locale, attempt]);

  const header = {
    badge: typeBadge(file.name, file.contentType),
    name: file.name,
    version: `v${file.version} · ${ago(file.versions[0]?.createdAt ?? file.createdAt, locale)}`,
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
        onRetry={() => setAttempt((n) => n + 1)}
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
