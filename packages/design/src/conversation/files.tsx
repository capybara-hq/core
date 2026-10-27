import { type JSX, useState } from "react";
import { IconButton } from "../controls/button";
import { formatBytes, isSafeAttachmentHref } from "../display/attachments";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { fillCopy } from "./tool-copy";

// Files in the conversation (spec §6.16.19–§6.16.21): file cards for what the agent delivered
// (UI copy says "files", never "artifacts"), inline image and text outputs, path chips, and the
// composer's attachment strip.

const ELLIPSIS = "…";
/** Extensions longer than this (with the dot) are not kept by middle truncation. */
const MAX_EXT = 10;

/**
 * Middle truncation that keeps the extension: "很长的名字…末尾.xlsx". `max` counts code points
 * (the ellipsis included); names that fit are returned as they are.
 */
export function middleTruncate(name: string, max: number): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const dot = name.lastIndexOf(".");
  let ext = dot > 0 ? [...name.slice(dot)] : [];
  if (ext.length > MAX_EXT || max - ext.length - 1 < 2) ext = [];
  const base = ext.length > 0 ? [...name.slice(0, dot)] : chars;
  const keep = Math.max(0, max - ext.length - 1);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${base.slice(0, head).join("")}${ELLIPSIS}${tail > 0 ? base.slice(base.length - tail).join("") : ""}${ext.join("")}`;
}

const BADGE_BY_TYPE: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
  "image/svg+xml": "SVG",
  "application/pdf": "PDF",
  "text/markdown": "MD",
  "text/plain": "TXT",
  "text/csv": "CSV",
  "text/tab-separated-values": "TSV",
  "text/html": "HTML",
  "application/json": "JSON",
  "application/zip": "ZIP",
  "application/gzip": "GZ",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
};

const baseType = (ct: string) => (ct.split(";")[0] ?? "").trim().toLowerCase();

/** The type badge: the file's extension (1–5 letters or digits), else its content type, else FILE. */
export function typeBadge(name: string, contentType: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (/^[a-z0-9]{1,5}$/i.test(ext)) return ext.toUpperCase();
  return BADGE_BY_TYPE[baseType(contentType)] ?? "FILE";
}

/** Bitmaps the kernel serves inline (`?inline=1`); SVG and the rest never render inline. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const isInlineImageType = (contentType: string): boolean =>
  INLINE_IMAGE_TYPES.has(baseType(contentType));

/**
 * An image source the design components load: http(s), a same-origin path, or a `blob:` URL the
 * page made itself (local previews of uploads). `data:`, `javascript:` and the rest are refused.
 */
export function isSafeImageSrc(src: string): boolean {
  if (/^blob:https?:\/\/[^\s\\]+$/i.test(src)) return true;
  return isSafeAttachmentHref(src);
}

/** The type badge (§6.16.19): `micro` 700 `muted`, 1px `line` border, radius `sm`. */
export function TypeBadge({ label }: { label: string }): JSX.Element {
  return (
    <span className="cb-type-badge" data-part="type-badge">
      {label}
    </span>
  );
}

export type FileCardProps = {
  name: string;
  contentType: string;
  /** Bytes. */
  size: number;
  /** The object is gone from storage: grayed, struck through, the reason instead of the size. */
  removed?: { reason: string };
  /** The file shown in the right panel. */
  selected?: boolean;
  /** Code points of the shown name before middle truncation (default 30). */
  maxChars?: number;
  onOpen?(): void;
};

/** A delivered file (§6.16.19): opens its preview in the right panel. */
export function FileCard(p: FileCardProps): JSX.Element {
  const badge = typeBadge(p.name, p.contentType);
  if (p.removed) {
    return (
      <div className="cb-file-card" data-part="file-card" data-removed="true" title={p.name}>
        <TypeBadge label={badge} />
        <s className="cb-file-name" data-part="file-name">
          {p.name}
        </s>
        <span className="cb-file-reason">{p.removed.reason}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="cb-file-card"
      data-part="file-card"
      data-selected={p.selected ? "true" : undefined}
      aria-current={p.selected ? "true" : undefined}
      title={p.name}
      onClick={p.onOpen}
    >
      <TypeBadge label={badge} />
      <span className="cb-file-name" data-part="file-name">
        {middleTruncate(p.name, p.maxChars ?? 30)}
      </span>
      <span className="cb-muted cb-file-size">{formatBytes(p.size)}</span>
      <Icon name="chevron-right" size={12} />
    </button>
  );
}

export type FileOutputItem = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  removed?: { reason: string };
};

/**
 * Several delivered files (§6.16.20): a two-column grid; past `max` (4), the first `max - 1` and a
 * card "N more files" that opens the Files section.
 */
export function FileOutputs({
  files,
  max = 4,
  selected,
  onOpen,
  onMore,
}: {
  files: FileOutputItem[];
  max?: number;
  /** The id of the file open in the right panel. */
  selected?: string;
  onOpen(id: string): void;
  onMore?(): void;
}): JSX.Element {
  const t = useDesignT();
  const card = (f: FileOutputItem, maxChars?: number) => (
    <FileCard
      key={f.id}
      name={f.name}
      contentType={f.contentType}
      size={f.size}
      selected={selected === f.id}
      {...(maxChars ? { maxChars } : {})}
      {...(f.removed ? { removed: f.removed } : {})}
      onOpen={() => onOpen(f.id)}
    />
  );
  if (files.length === 1 && files[0]) return card(files[0]);
  const over = files.length > max;
  const shown = over ? files.slice(0, Math.max(1, max - 1)) : files;
  return (
    <div className="cb-file-grid" data-part="file-grid">
      {shown.map((f) => card(f, 24))}
      {over ? (
        <button
          type="button"
          className="cb-file-card cb-file-more"
          data-part="file-more"
          onClick={onMore}
        >
          <span className="cb-file-more-text">
            {fillCopy(t("files.more"), { n: files.length - shown.length })}
          </span>
          <Icon name="chevron-right" size={12} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * An image file shown inline (§6.16.20): `layout.inline-image` wide at its own aspect ratio, enlarge
 * and download on hover, and a caption with the name, the natural size once loaded and the bytes.
 * `src` must be a bitmap served inline (`?inline=1`); SVG never renders inline.
 */
export function ImageOutput({
  src,
  name,
  size,
  onOpen,
  onDownload,
}: {
  src: string;
  name: string;
  size: number;
  onOpen(): void;
  onDownload(): void;
}): JSX.Element {
  const t = useDesignT();
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const safe = isSafeImageSrc(src);
  return (
    <figure className="cb-image-output" data-part="image-output">
      <div
        className="cb-image-frame"
        data-part="image-frame"
        data-loaded={dims ? "true" : undefined}
      >
        {safe ? (
          <button
            type="button"
            className="cb-image-open"
            aria-label={fillCopy(t("files.openImage"), { name })}
            onClick={onOpen}
          >
            <img
              src={src}
              alt={name}
              loading="lazy"
              referrerPolicy="no-referrer"
              onLoad={(e) => {
                const img = e.currentTarget;
                setDims({ w: img.naturalWidth, h: img.naturalHeight });
              }}
            />
          </button>
        ) : null}
        <div className="cb-image-tools" data-part="image-tools">
          <IconButton
            density="dense"
            variant="default"
            icon={<Icon name="zoom-in" size={14} />}
            label={t("files.enlarge")}
            onClick={onOpen}
          />
          <IconButton
            density="dense"
            variant="default"
            icon={<Icon name="download" size={14} />}
            label={t("files.download")}
            onClick={onDownload}
          />
        </div>
      </div>
      <figcaption className="cb-tool-line" data-part="tool-line">
        <span className="cb-tool-label">
          <span className="cb-ink">{name}</span>
          <span className="cb-faint">
            {dims ? ` · ${dims.w}×${dims.h} · ${formatBytes(size)}` : ` · ${formatBytes(size)}`}
          </span>
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * A text file shown inline (§6.16.20): the head (badge, name, size, Open) and its first lines as
 * plain text, fading out at the bottom. Never rendered as HTML.
 */
export function TextOutput({
  name,
  contentType = "",
  size,
  head,
  onOpen,
}: {
  name: string;
  contentType?: string;
  size?: number;
  /** The first lines of the file. */
  head: string;
  onOpen(): void;
}): JSX.Element {
  const t = useDesignT();
  return (
    <div className="cb-text-output" data-part="text-output">
      <div className="cb-text-output-head" data-part="text-output-head">
        <TypeBadge label={typeBadge(name, contentType)} />
        <span className="cb-file-name" title={name}>
          {name}
        </span>
        {size !== undefined ? <span className="cb-muted">{formatBytes(size)}</span> : null}
        <button type="button" className="cb-link-btn" onClick={onOpen}>
          {t("files.open")}
          <Icon name="chevron-right" size={12} />
        </button>
      </div>
      <pre className="cb-text-output-body" data-part="text-output-body">
        {head}
      </pre>
    </div>
  );
}

/** A file path mentioned in prose (§6.16.4): a mono chip that opens the file in the right panel. */
export function FileChip({ path, onOpen }: { path: string; onOpen(): void }): JSX.Element {
  return (
    <button type="button" className="cb-md-chip" data-part="file-chip" onClick={onOpen}>
      {path}
    </button>
  );
}

export type AttachmentStripItem = {
  id: string;
  kind: "image" | "file";
  name: string;
  contentType?: string;
  /** Bytes. */
  size: number;
  /** A thumbnail source (a `blob:` preview or a served bitmap). */
  src?: string;
  /** Upload progress 0–1 while uploading. */
  progress?: number;
  /** Why it was rejected (too large, wrong type, too many): shown in `fail` instead of the size. */
  error?: string;
  onRemove?(): void;
};

/**
 * The composer's attachments (§6.16.21): image thumbnails with a round remove button, file chips
 * (badge, name, size, remove), a progress bar while uploading, a `fail` border when rejected.
 */
export function AttachmentStrip({ items }: { items: AttachmentStripItem[] }): JSX.Element {
  const t = useDesignT();
  const removeLabel = (name: string) => fillCopy(t("attachment.remove"), { name });
  return (
    <div className="cb-attachment-strip" data-part="attachment-strip">
      {items.map((a) => {
        const state = a.error ? "rejected" : a.progress !== undefined ? "uploading" : "ready";
        const pct = Math.max(0, Math.min(100, Math.round((a.progress ?? 0) * 100)));
        if (a.kind === "image" && !a.error) {
          return (
            <span key={a.id} className="cb-strip-thumb-wrap" data-state={state}>
              <span className="cb-strip-thumb" data-part="thumb" role="img" aria-label={a.name}>
                {a.src !== undefined && isSafeImageSrc(a.src) ? (
                  <img src={a.src} alt="" referrerPolicy="no-referrer" />
                ) : null}
                {state === "uploading" ? (
                  <span
                    className="cb-strip-progress cb-strip-progress-thumb"
                    data-part="progress"
                    role="progressbar"
                    aria-label={fillCopy(t("attachment.uploading"), { name: a.name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                  >
                    <span className="cb-strip-progress-fill" style={{ width: `${pct}%` }} />
                  </span>
                ) : null}
              </span>
              {a.onRemove ? (
                <button
                  type="button"
                  className="cb-strip-thumb-remove"
                  data-part="thumb-remove"
                  aria-label={removeLabel(a.name)}
                  title={removeLabel(a.name)}
                  onClick={a.onRemove}
                >
                  <Icon name="x" size={12} />
                </button>
              ) : null}
            </span>
          );
        }
        const badge = <TypeBadge label={typeBadge(a.name, a.contentType ?? "")} />;
        const name = (
          <span className="cb-strip-name" title={a.name}>
            {a.name}
          </span>
        );
        if (state === "uploading") {
          return (
            <span key={a.id} className="cb-strip-chip" data-part="attachment" data-state={state}>
              <span className="cb-strip-row">
                {badge}
                {name}
                <span className="cb-muted">{`${pct}%`}</span>
              </span>
              <span
                className="cb-strip-progress"
                data-part="progress"
                role="progressbar"
                aria-label={fillCopy(t("attachment.uploading"), { name: a.name })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <span className="cb-strip-progress-fill" style={{ width: `${pct}%` }} />
              </span>
            </span>
          );
        }
        return (
          <span key={a.id} className="cb-strip-chip" data-part="attachment" data-state={state}>
            {badge}
            {name}
            {a.error ? (
              <span className="cb-fail-word" role="alert">
                {a.error}
              </span>
            ) : (
              <span className="cb-muted">{formatBytes(a.size)}</span>
            )}
            {a.onRemove ? (
              <IconButton
                density="dense"
                icon={<Icon name="x" size={12} />}
                label={removeLabel(a.name)}
                onClick={a.onRemove}
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
