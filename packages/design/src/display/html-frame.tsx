/**
 * The fixed sandbox of an HTML document (spec §6.43, file sharing design §4): scripts run and links
 * open in a new, unsandboxed tab; never `allow-same-origin` (the document gets an opaque origin: no
 * cookies, storage or DOM of the app), never `allow-top-navigation`, never `allow-forms`. The
 * kernel's response CSP carries the same flags.
 */
export const HTML_DOCUMENT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

export type HtmlDocumentFrameProps = {
  /** The kernel's HTML document URL (`/api/v1/html/<token>`). */
  src: string;
  /** The iframe's accessible name: the file name. */
  title: string;
};

/**
 * An HTML file shown as a whole document (spec §6.43). With `EmbedFrame` the only component that
 * renders an iframe (`apps/web` never writes one). It fills its container; the sandbox and the
 * referrer policy are fixed and cannot be widened by the caller.
 */
export function HtmlDocumentFrame({ src, title }: HtmlDocumentFrameProps) {
  return (
    <iframe
      className="cb-html-frame"
      data-part="html-frame"
      src={src}
      title={title}
      sandbox={HTML_DOCUMENT_SANDBOX}
      referrerPolicy="no-referrer"
    />
  );
}
