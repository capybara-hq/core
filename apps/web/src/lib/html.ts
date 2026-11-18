import { apiFetch } from "./api";

/**
 * HTML files rendered as whole documents (file sharing design §4): the kernel serves them under
 * `/api/v1/html/<token>` with a sandbox CSP; the web frames that path in the design's
 * `HtmlDocumentFrame`, never the file's bytes on the app origin.
 */

/** The largest HTML file rendered (the kernel's `FILE_PREVIEW_MAX_BYTES`); bigger ones download. */
export const HTML_RENDER_MAX_BYTES = 20 * 1024 * 1024;

/** A document token: `path` loads the document once within `expiresIn` seconds. */
export interface HtmlToken {
  path: string;
  expiresIn: number;
}

const enc = encodeURIComponent;

/** Mints a document token for one version of a conversation's HTML file (the owner only). */
export const requestHtmlToken = (orgId: string, conversationId: string, fileId: string) =>
  apiFetch<HtmlToken>(
    `/api/v1/orgs/${enc(orgId)}/conversations/${enc(conversationId)}/files/${enc(fileId)}/html-token`,
    { method: "POST" },
  );
