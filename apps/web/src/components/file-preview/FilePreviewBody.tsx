"use client";

import {
  Callout,
  CsvPreview,
  formatBytes,
  HtmlDocumentFrame,
  ImagePreview,
  ImageViewer,
  LoadFailed,
  MarkdownPreview,
  NoPreview,
  TextPreview,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { ApiClientError } from "../../lib/api";
import { type FileSource, sourceFile, sourceUrls } from "../../lib/file-source";
import { builtinPreview } from "../../lib/files";
import { HTML_RENDER_MAX_BYTES, requestHtmlToken } from "../../lib/html";
import type { FilePreviewerItem } from "../../lib/previewers";
import { filePreviewersQuery, filePreviewQuery, fileTextQuery } from "../../lib/query/conversation";
import { useAppMutation } from "../../lib/query/mutation";
import { shareTextQuery, shareViewQuery } from "../../lib/query/shares";
import { type UiView, uiLocale } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { useOpenDownload } from "../SessionFilePreview";
import { UiViewRenderer } from "../ui-view/UiViewRenderer";

/** The built-in previewer's option id (image, text, Markdown, CSV / TSV). */
export const BUILTIN = "builtin";
/** An HTML file's options: the rendered document, then its source as text. */
export const HTML_RENDERED = "html";
export const HTML_SOURCE = "source";

const previewerId = (p: FilePreviewerItem) => `${p.plugin}/${p.id}`;

/** A previewer the header offers. */
export type PreviewerOption = { id: string; title: string };

/**
 * What the body asks its frame to draw: the right panel's `FilePreviewFrame` or the share page's
 * `SharedFilePage`. `failed` carries what failed and why, Retry, and the fallback as `children`.
 */
export type FilePreviewBodyFrame = {
  state: "loading" | "ready" | "failed";
  failure?: { name?: string; reason?: string };
  onRetry?(): void;
  children?: ReactNode;
  /** The previewers that take the file, in order (a switch when more than one). */
  previewers: PreviewerOption[];
  /** The shown previewer's id (absent while none applies). */
  previewer?: string;
};

/** What an embed previewer's host gets: the previewer, its title, the file's bytes, the failure. */
export type FilePreviewEmbedHost = {
  previewer: FilePreviewerItem;
  title: string;
  read(): Promise<{ name: string; contentType: string; size: number; data: ArrayBuffer }>;
  failed(a: { message: string; onRetry(): void }): ReactNode;
};

type Option = { id: string; title: string; p: FilePreviewerItem | null };
type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; e: unknown };

/**
 * One file's body (file sharing design §5, §6), the same for the right panel and the share page:
 * only `source` differs. HTML files render as a whole document (the built-in wins over extension
 * previewers), with the source as text as the second option; otherwise extension previewers
 * come first, in the org's order, then the built-in (bitmaps, text and code, Markdown, CSV / TSV);
 * a file nothing takes shows the file card with Download. A failing previewer shows Retry with
 * the Download fallback; on a share page a view previewer that declines the share gives way to the
 * next option instead.
 */
export function FilePreviewBody({
  source,
  previewer,
  onDownload,
  frame,
  embed,
}: {
  source: FileSource;
  /** The previewer the person picked (an option id); null: the first option. */
  previewer: string | null;
  onDownload(): void;
  frame(f: FilePreviewBodyFrame): JSX.Element;
  /**
   * Hosts an embed previewer (the `file.preview` slot is rendered by its owner, the right panel;
   * the share page hosts it with a share-scoped token). Absent: embeds show the file card.
   */
  embed?(host: FilePreviewEmbedHost): ReactNode;
}): JSX.Element {
  const t = useTranslations("chat");
  const ts = useTranslations("shares.panel");
  const locale = uiLocale(useLocale());
  const errorMessage = useErrorMessage();
  const openDownload = useOpenDownload();
  const file = sourceFile(source);
  const urls = sourceUrls(source);
  const conv = source.kind === "conversation" ? source : null;
  const share = source.kind === "share" ? source : null;
  // For a share the kernel's `render` decides: `download` offers no previewer, `html` the
  // document, and `previewers` never the document (an HTML file over the limit gets its text).
  const offersNone = share?.meta.render === "download";
  const kind = offersNone
    ? null
    : builtinPreview({
        name: file.name,
        contentType: file.contentType,
        previewable: conv ? conv.file.previewable : (share?.meta.previewable ?? null),
      });
  const builtin =
    share === null || kind !== "html" || share.meta.render === "html"
      ? kind
      : share.meta.previewable === "text"
        ? "text"
        : null;
  const html = builtin === "html";
  const fileId = conv?.file.id ?? "";
  const orgId = conv?.orgId ?? "";
  const conversationId = conv?.conversationId ?? "";

  // The extension previewers that take the file: none for HTML (the built-in wins).
  const previewersQ = useQuery({
    ...filePreviewersQuery(orgId, conversationId, fileId),
    enabled: conv !== null && !html,
    retry: false,
  });
  const extensions: FilePreviewerItem[] | null = html
    ? []
    : share
      ? offersNone
        ? []
        : share.meta.previewers
      : previewersQ.data !== undefined
        ? previewersQ.data
        : previewersQ.error !== null
          ? []
          : null;

  // A share page has no previewer switch: a view previewer that declines the share (502
  // `ui.render_failed`, e.g. it needs the conversation) gives way to the next option, in the org's
  // order, then the built-in, then the file card with Download. Keyed by the link's code.
  const [declined, setDeclined] = useState<{ code: string; ids: readonly string[] }>({
    code: "",
    ids: [],
  });
  const skipped = share !== null && declined.code === share.code ? declined.ids : [];
  const allOptions: Option[] = html
    ? [
        { id: HTML_RENDERED, title: ts("rendered"), p: null },
        { id: HTML_SOURCE, title: ts("source"), p: null },
      ]
    : [
        ...(extensions ?? []).map((p) => ({ id: previewerId(p), title: p.title[locale], p })),
        ...(builtin !== null ? [{ id: BUILTIN, title: t("builtinPreviewer"), p: null }] : []),
      ];
  const options = allOptions.filter((o) => !skipped.includes(o.id));
  const current = options.find((o) => o.id === previewer) ?? options[0];
  const p = current?.p ?? null;
  // What the shown option reads: a view previewer's render, or the text of a text built-in
  // (HTML source included); bitmaps, embeds and the HTML document load themselves.
  const viewP = p !== null && p.kind === "view" ? p : null;
  const readsText =
    current !== undefined &&
    p === null &&
    builtin !== "image" &&
    !(html && current.id === HTML_RENDERED);

  const viewOpts = share
    ? shareViewQuery(share.code, viewP ?? { plugin: "", id: "" }, locale)
    : filePreviewQuery(orgId, conversationId, fileId, viewP ?? { plugin: "", id: "" }, locale);
  const viewQ = useQuery({
    ...viewOpts,
    enabled: extensions !== null && viewP !== null,
    retry: false,
  });
  const declines =
    share !== null &&
    viewP !== null &&
    viewQ.error instanceof ApiClientError &&
    viewQ.error.code === "ui.render_failed";
  const declinedId = declines ? current?.id : undefined;
  const shareCode = share?.code ?? "";
  useEffect(() => {
    if (declinedId === undefined) return;
    setDeclined((d) => {
      const ids = d.code === shareCode ? d.ids : [];
      return ids.includes(declinedId) ? d : { code: shareCode, ids: [...ids, declinedId] };
    });
  }, [declinedId, shareCode]);
  const textOpts = share
    ? shareTextQuery(share.code)
    : fileTextQuery(orgId, conversationId, fileId);
  const textQ = useQuery({ ...textOpts, enabled: extensions !== null && readsText, retry: false });

  // A conversation's HTML document loads through a token minted each time the rendered view
  // shows (the token only loads the document): nothing cached changes.
  const wantsToken =
    conv !== null && html && current?.id === HTML_RENDERED && file.size <= HTML_RENDER_MAX_BYTES;
  const token = useAppMutation({
    fn: (v: { orgId: string; conversationId: string; fileId: string }) =>
      requestHtmlToken(v.orgId, v.conversationId, v.fileId),
    invalidates: () => [],
  });
  const { mutate: mint, reset: dropToken } = token;
  useEffect(() => {
    if (wantsToken) mint({ orgId, conversationId, fileId });
    else dropToken();
  }, [wantsToken, orgId, conversationId, fileId, mint, dropToken]);
  const remint = () => mint({ orgId, conversationId, fileId });
  // Only this file's token counts: after a switch the previous answer never frames the new file.
  const tokenIsOurs =
    token.variables?.orgId === orgId &&
    token.variables.conversationId === conversationId &&
    token.variables.fileId === fileId;
  const tokenPath = tokenIsOurs ? token.data?.path : undefined;
  const tokenError = tokenIsOurs ? token.error : null;

  const body: Load<{ text?: string; truncated?: boolean; view?: UiView }> =
    extensions === null || current === undefined
      ? { kind: "loading" }
      : wantsToken
        ? tokenPath !== undefined
          ? { kind: "ready", data: {} }
          : tokenError !== null
            ? { kind: "error", e: tokenError }
            : { kind: "loading" }
        : viewP !== null
          ? declines
            ? // moving on to the next option
              { kind: "loading" }
            : viewQ.data !== undefined
              ? { kind: "ready", data: { view: viewQ.data } }
              : viewQ.error !== null
                ? { kind: "error", e: viewQ.error }
                : { kind: "loading" }
          : !readsText
            ? { kind: "ready", data: {} }
            : textQ.data !== undefined
              ? { kind: "ready", data: textQ.data }
              : textQ.error !== null
                ? { kind: "error", e: textQ.error }
                : { kind: "loading" };
  const retryBody = () =>
    void (wantsToken ? remint() : viewP !== null ? viewQ.refetch() : textQ.refetch());

  const header = {
    previewers: options.map((o) => ({ id: o.id, title: o.title })),
    ...(current ? { previewer: current.id } : {}),
  };
  const fallback = (
    <NoPreview
      name={file.name}
      contentType={file.contentType}
      size={file.size}
      hint={false}
      onDownload={onDownload}
    />
  );
  const failed = (name: string, e: unknown, onRetry?: () => void) => {
    const code = e instanceof ApiClientError ? e.code : "unknown";
    return frame({
      ...header,
      state: "failed",
      failure: { name, reason: errorMessage(new ApiClientError(0, code, code)) },
      ...(onRetry ? { onRetry } : {}),
      children: fallback,
    });
  };

  if (extensions !== null && !current) {
    return frame({
      ...header,
      state: "ready",
      children: (
        <NoPreview
          name={file.name}
          contentType={file.contentType}
          size={file.size}
          onDownload={onDownload}
        />
      ),
    });
  }
  if (extensions === null || !current || body.kind === "loading") {
    return frame({ ...header, state: "loading" });
  }
  if (body.kind === "error") return failed(current.title, body.e, retryBody);

  const data = body.data;
  let content: ReactNode = null;
  if (html && current.id === HTML_RENDERED) {
    if (file.size > HTML_RENDER_MAX_BYTES) {
      content = (
        <>
          <Callout tone="info">{ts("htmlTooLarge")}</Callout>
          {fallback}
        </>
      );
    } else if (share) {
      content = <HtmlDocumentFrame src={urls.html ?? ""} title={file.name} />;
    } else if (tokenPath !== undefined) {
      content = <HtmlDocumentFrame src={tokenPath} title={file.name} />;
    }
  } else if (p?.kind === "embed") {
    content =
      embed?.({
        previewer: p,
        title: current.title,
        read: async () => {
          const res = await fetch(urls.content, { credentials: "same-origin" });
          if (!res.ok) throw new ApiClientError(res.status, "http_error", "download failed");
          return {
            name: file.name,
            contentType: file.contentType,
            size: file.size,
            data: await res.arrayBuffer(),
          };
        },
        failed: ({ message, onRetry }) => (
          <>
            <LoadFailed name={current.title} reason={message} onRetry={onRetry} />
            {fallback}
          </>
        ),
      }) ?? fallback;
  } else if (p?.kind === "view" && data.view) {
    content = <UiViewRenderer view={data.view} onAction={async () => {}} />;
  } else if (builtin === "image") {
    const open = (url: string) =>
      conv ? openDownload(url) : window.open(url, "_blank", "noopener,noreferrer");
    content = (
      <PanelImage
        key={fileId}
        src={urls.inline}
        name={file.name}
        size={formatBytes(file.size)}
        onDownload={onDownload}
        onOpenInNewTab={() => open(urls.inline)}
      />
    );
  } else if (builtin === "markdown") {
    content = <MarkdownPreview text={data.text ?? ""} />;
  } else if (builtin === "csv" || builtin === "tsv") {
    content = <CsvPreview text={data.text ?? ""} delimiter={builtin === "csv" ? "," : "\t"} />;
  } else {
    content = <TextPreview text={data.text ?? ""} truncated={data.truncated === true} />;
  }
  return frame({ ...header, state: "ready", children: content });
}

/** The built-in image previewer: a click opens the image viewer for this file. */
function PanelImage({
  src,
  name,
  size,
  onDownload,
  onOpenInNewTab,
}: {
  src: string;
  name: string;
  size: string;
  onDownload(): void;
  onOpenInNewTab(): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ImagePreview src={src} name={name} onOpen={() => setOpen(true)} />
      <ImageViewer
        open={open}
        onOpenChange={setOpen}
        images={[{ src, name, size }]}
        index={0}
        onIndexChange={() => {}}
        onDownload={onDownload}
        onOpenInNewTab={onOpenInNewTab}
      />
    </>
  );
}
