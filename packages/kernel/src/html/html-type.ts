/**
 * Which files are HTML documents, and the content type they are served with (file sharing spec
 * §4, §5). The rule is the web's `isHtmlFile` (`apps/web/src/lib/files.ts`), so the panel and the
 * kernel agree on what renders.
 */

/** The content type without its parameters, lower case. */
const baseType = (contentType: string): string =>
  (contentType.split(";")[0] ?? "").trim().toLowerCase();

const ext = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** An HTML file: base type `text/html`, or a name ending in `.html` / `.htm` (any case). */
export function isHtmlType(name: string, contentType: string): boolean {
  const e = ext(name);
  return baseType(contentType) === "text/html" || e === "html" || e === "htm";
}

/** A charset name as a MIME token (IANA names: letters, digits and `-_.:+`), at most 40 chars. */
const CHARSET_RE = /^[a-z0-9][a-z0-9._:+-]{0,39}$/;

/**
 * `text/html; charset=<charset>`: the stored type's `charset` parameter (lower case, quotes
 * removed) when it is a valid token, else `utf-8`. The bytes are served as stored, so a file
 * delivered as GBK keeps rendering as GBK.
 */
export function htmlContentType(stored: string): string {
  let charset = "utf-8";
  for (const param of stored.split(";").slice(1)) {
    const eq = param.indexOf("=");
    if (eq < 0 || param.slice(0, eq).trim().toLowerCase() !== "charset") continue;
    const value = param
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .toLowerCase();
    if (CHARSET_RE.test(value)) charset = value;
    break;
  }
  return `text/html; charset=${charset}`;
}
