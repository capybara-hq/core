import { artifactDownloadUrl } from "./artifacts";
import { attachmentDownloadUrl } from "./attachments";
import type { FileOutput } from "./files";
import type { FilePreviewerItem } from "./previewers";

/**
 * Where a previewed file comes from (file sharing design §6): a conversation's file in the right
 * panel, or a share's snapshot on the public share page. The file body renders both the same way;
 * only the URLs and the reads differ, so formats never drift between the two.
 */
export type FileSource =
  | { kind: "conversation"; orgId: string; conversationId: string; file: FileOutput }
  | { kind: "share"; code: string; meta: ShareMeta };

/** A share as the public metadata route answers it (`GET /api/v1/s/:code`). */
export interface ShareMeta {
  name: string;
  contentType: string;
  size: number;
  /** The creator's display name. */
  sharedBy: string;
  expiresAt: string | null;
  audience: "internal" | "external";
  /** `html`: the HTML document; `previewers`: `previewers` or a web built-in; `download`: the card. */
  render: "html" | "previewers" | "download";
  /** The extension previewers that take the snapshot, in the org's order. */
  previewers: FilePreviewerItem[];
}

const enc = encodeURIComponent;

/** The share's public routes (`/api/v1/s/<code>…`). */
export const shareBase = (code: string) => `/api/v1/s/${enc(code)}`;

/**
 * The URLs of a source's bytes: `download` (an attachment download), `inline` (a bitmap shown in
 * place), `content` (the bytes an embed previewer reads) and, for a share, `html` (redirects to the
 * HTML document; the panel mints its document token instead).
 */
export function sourceUrls(s: FileSource): {
  download: string;
  inline: string;
  content: string;
  html?: string;
} {
  if (s.kind === "share") {
    const b = shareBase(s.code);
    return {
      download: `${b}/content?download=1`,
      inline: `${b}/inline`,
      content: `${b}/content`,
      html: `${b}/html`,
    };
  }
  const { orgId, conversationId, file } = s;
  // An uploaded file is an attachment: its own route downloads it and serves bitmaps inline.
  if (file.origin === "uploaded") {
    const url = attachmentDownloadUrl(orgId, file.id);
    return { download: url, inline: url, content: url };
  }
  const download = artifactDownloadUrl(orgId, conversationId, file.id, {});
  return {
    download,
    inline: artifactDownloadUrl(orgId, conversationId, file.id, { inline: true }),
    content: download,
  };
}

/** The file's name, type and size, whatever the source. */
export const sourceFile = (s: FileSource): { name: string; contentType: string; size: number } =>
  s.kind === "share" ? s.meta : s.file;
