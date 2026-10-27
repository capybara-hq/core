import type { Locale } from "./cards.js";
import type { UiView } from "./ui.js";

/** File previewer extension point ref (UI refresh spec §5.8). */
export const FILE_PREVIEW_EXTENSION_POINT = "file-preview@1";

/** Largest file a previewer may declare (`FilePreviewer.maxBytes`): 20 MiB. */
export const FILE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/**
 * One previewer of a `file-preview@1` provider: which files it previews and how. It renders either a
 * view (`render`, drawn by the web app like any `UiView`) or an embed page (`embed`, the id of a ui
 * contribution `{ kind: "embed", place: "file-preview" }` of the same extension, which receives the
 * file over the message bridge). Exactly one of the two.
 */
export interface FilePreviewer {
  /** Unique within the extension, `[a-z0-9-]{1,40}`. */
  id: string;
  title: { zh: string; en: string };
  /**
   * Files it accepts: MIME types (`image/*` wildcards allowed) and / or file extensions (with or
   * without the dot; matched case-insensitively). At least one entry.
   */
  accepts: { mimeTypes?: string[]; extensions?: string[] };
  /** Largest file it previews, at most {@link FILE_PREVIEW_MAX_BYTES}. */
  maxBytes: number;
  render?(args: FilePreviewArgs): Promise<UiView>;
  embed?: string;
}

/** What a `file-preview@1` extension provides (`ctx.provide("file-preview@1", provider)`). */
export interface FilePreviewProvider {
  previewers: FilePreviewer[];
}

/** Arguments of {@link FilePreviewer.render}; identities come from the kernel after authentication. */
export interface FilePreviewArgs {
  orgId: string;
  accountId: string;
  conversationId: string;
  locale: Locale;
  /** Aborted at the kernel's time limit: stop reading and rendering. */
  signal: AbortSignal;
  file: { id: string; name: string; contentType: string; size: number };
  /**
   * The read grant: this one file's bytes, valid only during this call (rejects afterwards), and
   * rejects a file over the previewer's `maxBytes`. The extension never gets a storage key or URL.
   */
  read(): Promise<Uint8Array>;
}

const ID_RE = /^[a-z0-9-]{1,40}$/;
const TITLE_MAX = 100;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "" && s.length <= 100);

/** Checks a `file-preview@1` provider; returns the problems (empty = valid). */
export function validateFilePreviewProvider(p: unknown): string[] {
  if (!isObj(p)) return ["provider must be an object"];
  if (!Array.isArray(p.previewers) || p.previewers.length === 0)
    return ["previewers must be a non-empty array"];
  const out: string[] = [];
  const seen = new Set<string>();
  p.previewers.forEach((v: unknown, i: number) => {
    const at = `previewers[${i}]`;
    if (!isObj(v)) {
      out.push(`${at} must be an object`);
      return;
    }
    if (typeof v.id !== "string" || !ID_RE.test(v.id))
      out.push(`${at}.id must match ${ID_RE.source}`);
    else if (seen.has(v.id)) out.push(`${at}.id "${v.id}" is a duplicate`);
    else seen.add(v.id);
    const t = v.title;
    if (
      !isObj(t) ||
      [t.zh, t.en].some((s) => typeof s !== "string" || s === "" || s.length > TITLE_MAX)
    )
      out.push(`${at}.title needs non-empty zh and en of at most ${TITLE_MAX} characters`);
    const a = v.accepts;
    if (
      !isObj(a) ||
      (a.mimeTypes !== undefined && !strings(a.mimeTypes)) ||
      (a.extensions !== undefined && !strings(a.extensions)) ||
      ((a.mimeTypes as unknown[] | undefined)?.length ?? 0) +
        ((a.extensions as unknown[] | undefined)?.length ?? 0) ===
        0
    )
      out.push(`${at}.accepts needs at least one MIME type or extension`);
    if (
      typeof v.maxBytes !== "number" ||
      !Number.isInteger(v.maxBytes) ||
      v.maxBytes < 1 ||
      v.maxBytes > FILE_PREVIEW_MAX_BYTES
    )
      out.push(`${at}.maxBytes must be an integer from 1 to ${FILE_PREVIEW_MAX_BYTES}`);
    const hasRender = typeof v.render === "function";
    const hasEmbed = v.embed !== undefined;
    if (hasRender === hasEmbed) out.push(`${at} must have exactly one of render or embed`);
    else if (hasEmbed && (typeof v.embed !== "string" || v.embed === ""))
      out.push(`${at}.embed must be the id of a ui contribution`);
  });
  return out;
}

const baseType = (t: string): string => (t.split(";")[0] ?? "").trim().toLowerCase();

/** Whether a previewer takes this file: its type or extension is accepted and it is within `maxBytes`. */
export function previewerAccepts(
  p: Pick<FilePreviewer, "accepts" | "maxBytes">,
  file: { name: string; contentType: string; size: number },
): boolean {
  if (file.size > p.maxBytes) return false;
  const type = baseType(file.contentType);
  const typeOk = (p.accepts.mimeTypes ?? []).some((m) => {
    const want = m.toLowerCase();
    return want.endsWith("/*") ? type.startsWith(want.slice(0, -1)) : type === want;
  });
  if (typeOk) return true;
  const name = file.name.toLowerCase();
  return (p.accepts.extensions ?? []).some((e) => {
    const ext = e.toLowerCase().replace(/^\.?/, ".");
    return name.endsWith(ext) && name.length > ext.length;
  });
}
