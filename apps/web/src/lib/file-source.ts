import { artifactDownloadUrl } from "./artifacts";
import type { FileOutput } from "./files";
import type { FilePreviewerItem } from "./previewers";
import { skillFileContentUrl } from "./skills";
import { fileDownloadUrl } from "./uploads";

/**
 * Where a previewed file comes from (file sharing design §6): a conversation's file in the right
 * panel, a share's snapshot on the public share page, or a file of a skill version on the skill's
 * Files tab (skill file browser design). The file body renders them the same way; only the URLs and
 * the reads differ, so formats never drift between them.
 */
export type FileSource =
  | { kind: "conversation"; orgId: string; conversationId: string; file: FileOutput }
  | { kind: "share"; code: string; meta: ShareMeta }
  | { kind: "skill"; orgId: string; skillId: string; version: number; file: SkillSourceFile };

/** A skill version's file as the body reads it: its manifest path and its last segment. */
export interface SkillSourceFile {
  path: string;
  name: string;
  contentType: string;
  size: number;
  previewable: "image" | "text" | null;
}

/** A share as the public metadata route answers it (`GET /api/v1/s/:code`). */
export interface ShareMeta {
  name: string;
  contentType: string;
  size: number;
  /** The creator's display name. */
  sharedBy: string;
  expiresAt: string | null;
  audience: "internal" | "external";
  /** The built-in kind the share routes serve (the conversation files list's rule). */
  previewable: "image" | "text" | null;
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
 * HTML document; the panel mints its document token instead). A skill file has no `html`: it is
 * never rendered as a document.
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
  if (s.kind === "skill") {
    const content = skillFileContentUrl(s.orgId, s.skillId, s.version, s.file.path);
    return {
      download: content,
      inline: skillFileContentUrl(s.orgId, s.skillId, s.version, s.file.path, { inline: true }),
      content,
    };
  }
  const { orgId, conversationId, file } = s;
  // An uploaded file is a library file: its own route downloads it and serves bitmaps inline.
  if (file.origin === "uploaded") {
    const url = fileDownloadUrl(orgId, file.id);
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
