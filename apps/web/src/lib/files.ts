import { ApiClientError, apiFetch } from "./api";

/**
 * A conversation's files (kernel `conversations/files.ts`, UI refresh B): what the agent delivered,
 * grouped by source path into versions, and what people sent with messages (attachments), newest
 * first. Text content comes back as plain text (never served as HTML), at most 1 MiB.
 */
export interface FileOutput {
  /** The latest version's artifact id; an uploaded file's attachment id. */
  id: string;
  name: string;
  contentType: string;
  size: number;
  sourcePath: string;
  version: number;
  versions: { id: string; size: number; createdAt: string }[];
  callId: string;
  createdAt: string;
  /** `removed`: the stored object is gone (decision 8). */
  status: "available" | "removed";
  previewable: "image" | "text" | null;
  /**
   * `delivered`: the agent delivered it (downloads through the conversation's artifact route);
   * `uploaded`: a person sent it with a message (an attachment: one version, downloads and shows
   * inline through the attachment route).
   */
  origin: "delivered" | "uploaded";
  /** The viewer has a live share of this file (any version of its source path, or the upload). */
  shared: boolean;
  /**
   * Set by the page, never by the kernel: a sub-agent's delivery listed in its parent, read from
   * (and previewed through) the child conversation.
   */
  from?: { conversationId: string; name: string };
}

const one = (orgId: string, conversationId: string) =>
  `/api/v1/orgs/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}`;

/** The most files the page reads (pages of 100). */
export const FILES_MAX = 500;

/** Every file output of the conversation (up to {@link FILES_MAX}), newest first. */
export async function listFiles(orgId: string, conversationId: string): Promise<FileOutput[]> {
  const out: FileOutput[] = [];
  let after: string | null = null;
  do {
    const q: string =
      after === null ? "?limit=100" : `?limit=100&after=${encodeURIComponent(after)}`;
    const page: { files: FileOutput[]; next: string | null } = await apiFetch(
      `${one(orgId, conversationId)}/files${q}`,
    );
    out.push(...page.files);
    after = page.next;
  } while (after !== null && out.length < FILES_MAX);
  return out;
}

/** The most bytes a built-in text preview reads. */
export const TEXT_PREVIEW_BYTES = 1024 * 1024;

/**
 * The first bytes of a text file version as text; `truncated` when cut. Not text →
 * `conversation.artifact_not_previewable`; gone → `conversation.artifact_removed`.
 */
export function fileText(
  orgId: string,
  conversationId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  return readTextPreview(
    `${one(orgId, conversationId)}/files/${encodeURIComponent(fileId)}/content?limit=${TEXT_PREVIEW_BYTES}`,
    signal,
  );
}

/**
 * Reads a text preview route (the panel's or a share's): the body as text, `truncated` from
 * `x-content-truncated`; a failure throws the kernel's error code.
 */
export async function readTextPreview(
  url: string,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(url, { credentials: "same-origin", ...(signal ? { signal } : {}) });
  if (!res.ok) {
    let code = "http_error";
    try {
      const body = (await res.json()) as { error?: { code?: string } };
      if (typeof body.error?.code === "string") code = body.error.code;
    } catch {
      // not JSON
    }
    throw new ApiClientError(res.status, code, code);
  }
  return { text: await res.text(), truncated: res.headers.get("x-content-truncated") === "true" };
}

/** A built-in previewer for a file, or null (the file card and Download). */
export type BuiltinPreview = "html" | "image" | "markdown" | "csv" | "tsv" | "text";

const ext = (name: string) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** The content type without its parameters, lower case (`text/html; charset=gbk` → `text/html`). */
const baseType = (contentType: string) => (contentType.split(";")[0] ?? "").trim().toLowerCase();

/**
 * An HTML file (file sharing design §5): base type `text/html`, or a name ending in `.html` /
 * `.htm` (any case). The panel renders it as a whole document, ahead of extension previewers.
 */
export const isHtmlFile = (f: { name: string; contentType: string }): boolean => {
  const e = ext(f.name);
  return baseType(f.contentType) === "text/html" || e === "html" || e === "htm";
};

/**
 * Which built-in previewer takes a file (spec §5.8): HTML documents first (file sharing design
 * §5), then bitmaps, text and code, Markdown, CSV / TSV.
 */
export function builtinPreview(
  f: Pick<FileOutput, "name" | "contentType" | "previewable">,
): BuiltinPreview | null {
  if (isHtmlFile(f)) return "html";
  if (f.previewable === "image") return "image";
  if (f.previewable !== "text") return null;
  const e = ext(f.name);
  const type = baseType(f.contentType);
  if (e === "md" || e === "markdown" || type === "text/markdown") return "markdown";
  if (e === "csv" || type === "text/csv") return "csv";
  if (e === "tsv" || type === "text/tab-separated-values") return "tsv";
  return "text";
}
