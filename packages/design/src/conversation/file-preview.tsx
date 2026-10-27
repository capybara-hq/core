import type { JSX, ReactNode } from "react";
import { Button, IconButton } from "../controls/button";
import { formatBytes } from "../display/attachments";
import { Icon } from "../icons/icon";
import { Menu } from "../overlays/menus";
import { useDesignT } from "../provider";
import { isSafeImageSrc, TypeBadge, typeBadge } from "./files";
import { Prose } from "./prose";
import { fillCopy } from "./tool-copy";

// The file preview in the right panel (spec §6.16.22): the frame (header and body) and the built-in
// previewers (image, text, Markdown, CSV / TSV, none). Previewers never run in the stream; a slow or
// failing one affects only this panel. There is no Share (sharing belongs to Artifacts).

/** An extension block that failed to load (§6.16): the name, the reason and Retry, in place. */
export function LoadFailed({
  name,
  reason,
  onRetry,
}: {
  name: string;
  reason?: string;
  onRetry?(): void;
}): JSX.Element {
  const t = useDesignT();
  return (
    <div className="cb-load-failed" role="alert">
      <span className="cb-load-failed-title" data-part="load-failed-title">
        <Icon name="circle-alert" size={14} />
        {fillCopy(t("files.loadFailed"), { name })}
      </span>
      {reason ? <span className="cb-muted">{reason}</span> : null}
      {onRetry ? (
        <button type="button" className="cb-link-btn" onClick={onRetry}>
          <Icon name="refresh" size={12} />
          {t("conv.retry")}
        </button>
      ) : null}
    </div>
  );
}

export type FilePreviewHeader = {
  /** The type badge ("CSV"). */
  badge: string;
  name: string;
  /** "v<n> · <updated>". */
  version?: string;
  /** The conversation's files: the name becomes a switcher. */
  files?: { id: string; name: string }[];
  /** The id of the shown file in `files`. */
  current?: string;
  onSwitch?(id: string): void;
  /** The previewers that accept the file; a switch appears when there is more than one. */
  previewers?: { id: string; title: string }[];
  previewer?: string;
  onPreviewer?(id: string): void;
  onDownload(): void;
  onFullscreen(): void;
  onClose(): void;
};

export type FilePreviewFrameProps = {
  header: FilePreviewHeader;
  state: "loading" | "ready" | "failed";
  /** What failed (default: the previewer title, else "Preview") and why. */
  failure?: { name?: string; reason?: string };
  onRetry?(): void;
  /** The previewer; when failed, the fallback (usually {@link NoPreview}). */
  children?: ReactNode;
};

/** The right panel showing a file (§6.16.22). */
export function FilePreviewFrame({
  header: h,
  state,
  failure,
  onRetry,
  children,
}: FilePreviewFrameProps): JSX.Element {
  const t = useDesignT();
  const switcher = h.files && h.files.length > 0 && h.onSwitch;
  const title = switcher ? (
    <Menu
      trigger={
        <Button variant="ghost" aria-haspopup="menu">
          <span className="cb-rpanel-title-text">{h.name}</span>
          <Icon name="chevron-down" size={14} />
        </Button>
      }
      items={(h.files ?? []).map((f) => ({
        label: f.name,
        checked: f.id === h.current,
        onSelect: () => h.onSwitch?.(f.id),
      }))}
    />
  ) : (
    <span className="cb-rpanel-title-text cb-rpanel-title-plain">{h.name}</span>
  );
  const previewers = h.previewers ?? [];
  const current = previewers.find((p) => p.id === h.previewer) ?? previewers[0];
  const previewerSwitch =
    previewers.length > 1 && h.onPreviewer && current ? (
      <Menu
        trigger={
          <Button variant="ghost" density="dense" aria-haspopup="menu">
            {current.title}
            <Icon name="chevron-down" size={12} />
          </Button>
        }
        items={previewers.map((p) => ({
          label: p.title,
          checked: p.id === current.id,
          onSelect: () => h.onPreviewer?.(p.id),
        }))}
      />
    ) : null;
  let body: ReactNode;
  if (state === "failed") {
    body = (
      <div className="cb-preview-center">
        <LoadFailed
          name={failure?.name ?? current?.title ?? t("files.preview")}
          {...(failure?.reason ? { reason: failure.reason } : {})}
          {...(onRetry ? { onRetry } : {})}
        />
        {children}
      </div>
    );
  } else if (state === "loading") {
    body = (
      <div className="cb-preview-center cb-muted" data-part="preview-loading">
        {t("files.loadingPreview")}
      </div>
    );
  } else {
    body = children;
  }
  return (
    <aside className="cb-rpanel" data-part="right-panel" aria-label={h.name}>
      <header className="cb-rpanel-head" data-part="panel-head">
        <TypeBadge label={h.badge} />
        {title}
        {h.version ? <span className="cb-faint cb-small cb-rpanel-meta">{h.version}</span> : null}
        <span className="cb-rpanel-grow" />
        {previewerSwitch}
        <IconButton
          icon={<Icon name="download" size={16} />}
          label={t("files.download")}
          onClick={h.onDownload}
        />
        <IconButton
          icon={<Icon name="maximize-2" size={16} />}
          label={t("files.fullscreen")}
          onClick={h.onFullscreen}
        />
        <IconButton
          icon={<Icon name="x" size={16} />}
          label={t("overlay.close")}
          onClick={h.onClose}
        />
      </header>
      <div
        className="cb-rpanel-body"
        data-state={state}
        aria-busy={state === "loading" ? true : undefined}
      >
        {body}
      </div>
    </aside>
  );
}

// ── Built-in previewers ─────────────────────────────────────────────────────

/** Plain text and source code: mono, wrapped, shown as text (never HTML, never executed). */
export function TextPreview({ text, truncated }: { text: string; truncated: boolean }) {
  const t = useDesignT();
  return (
    <div className="cb-preview-scroll">
      <pre className="cb-preview-text" data-part="preview-text">
        {text}
      </pre>
      {truncated ? (
        <div className="cb-preview-note" data-part="preview-note">
          {t("files.truncated")}
        </div>
      ) : null}
    </div>
  );
}

/** Markdown through the design Markdown rules (§6.16.4): no raw HTML, links http(s) only. */
export function MarkdownPreview({ text }: { text: string }): JSX.Element {
  return (
    <div className="cb-preview-scroll cb-preview-md">
      <Prose markdown={text} />
    </div>
  );
}

/** A bitmap scaled to fit on the `panel` ground. `src` is a `?inline=1` URL; never SVG. */
export function ImagePreview({ src, name }: { src: string; name: string }): JSX.Element {
  return (
    <div className="cb-preview-image" data-part="preview-image">
      {isSafeImageSrc(src) ? <img src={src} alt={name} referrerPolicy="no-referrer" /> : null}
    </div>
  );
}

/** No previewer for the file: the card with type, size and Download. */
export function NoPreview({
  name,
  contentType,
  size,
  hint = true,
  onDownload,
}: {
  name: string;
  contentType: string;
  size: number;
  /** Says "No preview available" after the size (off for the failed fallback). */
  hint?: boolean;
  onDownload(): void;
}): JSX.Element {
  const t = useDesignT();
  return (
    <div className="cb-preview-center">
      <div className="cb-no-preview" data-part="no-preview">
        <TypeBadge label={typeBadge(name, contentType)} />
        <div className="cb-no-preview-text">
          <div className="cb-no-preview-name" title={name}>
            {name}
          </div>
          <div className="cb-muted cb-small">
            {hint ? `${formatBytes(size)} · ${t("files.noPreview")}` : formatBytes(size)}
          </div>
        </div>
        <Button onClick={onDownload}>
          <Icon name="download" size={14} />
          {t("files.download")}
        </Button>
      </div>
    </div>
  );
}

/**
 * RFC 4180 CSV / TSV: quoted fields may hold the delimiter, `""` and line breaks; CRLF or LF rows;
 * a byte-order mark and a final line break are ignored.
 */
export function parseCsv(text: string, delimiter: "," | "\t"): string[][] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      i++;
    } else if (c === delimiter) {
      row.push(cell);
      cell = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      cell += c;
      i++;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const NUMBER = /^[+\-−]?[\d,]+(\.\d+)?%?$/;

/** CSV / TSV as a flush table: header then at most `maxRows` rows, numbers right-aligned. */
export function CsvPreview({
  text,
  delimiter,
  maxRows = 500,
}: {
  text: string;
  delimiter: "," | "\t";
  maxRows?: number;
}): JSX.Element {
  const t = useDesignT();
  const [head = [], ...body] = parseCsv(text, delimiter);
  const shown = body.slice(0, maxRows);
  const width = Math.max(head.length, ...shown.map((r) => r.length));
  const numeric = Array.from({ length: width }, (_, j) => {
    const cells = shown.map((r) => (r[j] ?? "").trim()).filter((c) => c !== "");
    return cells.length > 0 && cells.every((c) => NUMBER.test(c));
  });
  const align = (j: number) => (numeric[j] ? "right" : undefined);
  const cols = Array.from({ length: width }, (_, j) => j);
  return (
    <div className="cb-preview-scroll cb-preview-flush">
      <table className="cb-preview-table" data-part="preview-table">
        <thead>
          <tr>
            {cols.map((j) => (
              <th key={j} data-part="preview-table-head" data-align={align(j)}>
                {head[j] ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity; order is fixed
            <tr key={i}>
              {cols.map((j) => (
                <td key={j} data-part="preview-table-cell" data-align={align(j)}>
                  {r[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length ? (
        <div className="cb-preview-note" data-part="preview-note">
          {fillCopy(t("files.rowsShown"), {
            n: shown.length.toLocaleString("en-US"),
            m: body.length.toLocaleString("en-US"),
          })}
        </div>
      ) : null}
    </div>
  );
}
