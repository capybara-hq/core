import { ApiClientError, apiFetch } from "./api";

/**
 * A conversation's file outputs (kernel `conversations/files.ts`, UI refresh B): what the agent
 * delivered, newest first by first delivery, grouped by source path into versions. Text content
 * comes back as plain text (never served as HTML), at most 1 MiB.
 */
export interface FileOutput {
  /** The latest version's artifact id. */
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
export async function fileText(
  orgId: string,
  conversationId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(
    `${one(orgId, conversationId)}/files/${encodeURIComponent(fileId)}/content?limit=${TEXT_PREVIEW_BYTES}`,
    { credentials: "same-origin", ...(signal ? { signal } : {}) },
  );
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
export type BuiltinPreview = "image" | "markdown" | "csv" | "tsv" | "text";

const ext = (name: string) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** Which built-in previewer takes a file (spec §5.8): bitmaps, text and code, Markdown, CSV / TSV. */
export function builtinPreview(
  f: Pick<FileOutput, "name" | "contentType" | "previewable">,
): BuiltinPreview | null {
  if (f.previewable === "image") return "image";
  if (f.previewable !== "text") return null;
  const e = ext(f.name);
  const type = (f.contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (e === "md" || e === "markdown" || type === "text/markdown") return "markdown";
  if (e === "csv" || type === "text/csv") return "csv";
  if (e === "tsv" || type === "text/tab-separated-values") return "tsv";
  return "text";
}
