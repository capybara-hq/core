import { SaxesParser, type SaxesTagNS } from "saxes";
import { isSafePackagePath } from "./plugin-package.js";
import { type ParsedTheme, THEME_LIMITS } from "./theme.js";

/**
 * Checks of a theme's asset files (themes spec §4.2-§4.4): woff2 fonts, PNG logos and the SVG
 * sanitizer. The sanitized SVG is served to every browser, so {@link sanitizeThemeSvg} is a trust
 * boundary: the output is re-serialized from the parsed tree (never the input bytes), elements are
 * allowlisted, every attribute value and text node is escaped on output.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** SVG elements a logo may use: shapes, structure, paint servers, filters and animation. */
const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "metadata",
  "a",
  "switch",
  "view",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "image",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "clipPath",
  "mask",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "animate",
  "animateMotion",
  "animateTransform",
  "set",
  "mpath",
]);

/** `xml:` attributes kept; `xml:base` and the rest are dropped. */
const XML_ATTRS: ReadonlySet<string> = new Set(["space", "lang"]);
/** Root attributes dropped: the design system sizes the logo to its slot. */
const ROOT_DROPPED: ReadonlySet<string> = new Set(["width", "height", "class"]);
/** Characters of a viewBox value; longer values are refused before they are split. */
const VIEWBOX_MAX_CHARS = 128;
/** Characters a viewBox number may use (checked per character class, no backtracking). */
const VIEWBOX_NUMBER_RE = /^[-+.0-9eE]+$/;
/**
 * The only functions an attribute value may call: colors and transforms. `url` is allowed only as
 * `url(#id)` (checked separately); everything else (`image-set`, `cross-fade`, `element`,
 * `src`, `var`, ...) is refused, since some of them load resources from quoted strings.
 */
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "url",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "translate",
  "rotate",
  "scale",
  "matrix",
  "skewx",
  "skewy",
]);
const isIdentChar = (c: string) => /[A-Za-z0-9_-]/.test(c);
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
// biome-ignore lint/suspicious/noControlCharactersInRegex: whitespace and control characters are stripped before matching schemes
const IGNORED_IN_SCHEME_RE = /[\u0000- \u007f]/g;

class SvgRejected extends Error {}

const reject = (message: string): never => {
  throw new SvgRejected(message);
};

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) =>
  escapeText(s)
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");

/** Rejects an attribute value that could run script or load a resource outside the document. */
function checkValue(el: string, attr: string, value: string): void {
  const squeezed = value.replace(IGNORED_IN_SCHEME_RE, "").toLowerCase();
  if (squeezed.includes("javascript:") || squeezed.includes("vbscript:")) {
    reject(`attribute ${attr} on <${el}> must not contain javascript: or vbscript: URLs`);
  }
  // CSS escapes could spell a function name; quoted strings are how CSS functions take URLs.
  if (value.includes("\\")) reject(`attribute ${attr} on <${el}> must not contain "\\"`);
  if (value.includes("'") || value.includes('"')) {
    reject(`attribute ${attr} on <${el}> must not contain quotes`);
  }
  // Linear scan: at every "(", walk back over spaces and the function name.
  for (let i = value.indexOf("("); i !== -1; i = value.indexOf("(", i + 1)) {
    let end = i;
    while (end > 0 && isSpace(value.charAt(end - 1))) end -= 1;
    let start = end;
    while (start > 0 && isIdentChar(value.charAt(start - 1))) start -= 1;
    const fn = value.slice(start, end).toLowerCase();
    if (!ALLOWED_FUNCTIONS.has(fn)) {
      reject(
        `attribute ${attr} on <${el}> must not call ${fn === "" ? "a bare (" : `${fn}()`}; only url(#id), colors and transforms are allowed`,
      );
    }
    if (fn === "url") {
      let j = i + 1;
      while (j < value.length && isSpace(value.charAt(j))) j += 1;
      if (value.charAt(j) !== "#") {
        reject(`attribute ${attr} on <${el}> may only reference url(#id) inside the document`);
      }
    }
  }
}

/** `min-x min-y width height`, width and height > 0; undefined when malformed. */
function parseViewBox(v: string): [number, number, number, number] | undefined {
  if (v.length > VIEWBOX_MAX_CHARS) return undefined;
  const parts = v
    .trim()
    .split(/[\s,]+/)
    .filter((p) => p !== "");
  if (parts.length !== 4 || !parts.every((p) => VIEWBOX_NUMBER_RE.test(p))) return undefined;
  const n = parts.map(Number) as [number, number, number, number];
  if (!n.every(Number.isFinite) || n[2] <= 0 || n[3] <= 0) return undefined;
  return n;
}

/** The serialized attributes of an allowed SVG element; rejects the forbidden ones. */
function attributesOf(tag: SaxesTagNS, isRoot: boolean, usesXlink: { value: boolean }): string {
  const el = tag.local;
  let out = "";
  for (const a of Object.values(tag.attributes)) {
    const lower = a.local.toLowerCase();
    if (a.uri === XMLNS_NS || a.name === "xmlns") continue;
    let name: string;
    if (a.uri === "") {
      if (lower === "style") reject(`attribute style on <${el}> is not allowed`);
      if (lower.startsWith("on"))
        reject(`event handler attribute ${a.name} on <${el}> is not allowed`);
      if (isRoot && ROOT_DROPPED.has(a.local)) continue;
      name = a.local;
    } else if (a.uri === XLINK_NS) {
      usesXlink.value = true;
      name = `xlink:${a.local}`;
    } else if (a.uri === XML_NS) {
      if (!XML_ATTRS.has(a.local)) continue;
      name = `xml:${a.local}`;
    } else {
      // Editor metadata (inkscape:*, sodipodi:*, …) in foreign namespaces is dropped.
      continue;
    }
    if (lower === "href" && !a.value.startsWith("#")) {
      reject(`attribute ${name} on <${el}> must reference an element of the document (#id)`);
    }
    if (lower === "attributename") {
      const target = (a.value.split(":").pop() ?? "").trim().toLowerCase();
      if (target === "href" || target === "style" || target.startsWith("on")) {
        reject(`<${el}> must not animate ${a.value}`);
      }
    }
    checkValue(el, name, a.value);
    out += ` ${name}="${escapeAttr(a.value)}"`;
  }
  return out;
}

/**
 * Parses a logo SVG (UTF-8, ≤ {@link THEME_LIMITS}`.svgBytes`) with a strict, namespace-aware
 * XML parser and re-serializes it. The root must be an `svg` element in the SVG namespace with a
 * numeric `viewBox`; its `width`, `height` and `class` are dropped. Rejected: a DOCTYPE (and so
 * any entity declaration), processing instructions, a non-UTF-8 encoding, elements outside the
 * SVG allowlist (`script`, `foreignObject`, `style`, …) or in the XHTML namespace, `style` and
 * `on*` attributes, `href` / `xlink:href` not starting with `#`, `javascript:` / `vbscript:` in
 * any value, quotes or a backslash in attribute values, any function other than `url(#id)`, colors
 * (`rgb`, `rgba`, `hsl`, `hsla`) and transforms (`translate`, `rotate`, `scale`, `matrix`,
 * `skewX`, `skewY`), a viewBox longer than 128 characters, and animation of `href`, `style` or event
 * handlers. Comments, the XML declaration and elements / attributes in other namespaces (editor
 * metadata) are dropped; CDATA becomes escaped text. Never throws.
 */
export function sanitizeThemeSvg(bytes: Uint8Array): { svg: string } | { error: string } {
  const r = sanitize(bytes);
  return "error" in r ? r : { svg: r.svg };
}

/** {@link sanitizeThemeSvg} plus the root viewBox (for the favicon's squareness). */
function sanitize(
  bytes: Uint8Array,
): { svg: string; viewBox: [number, number, number, number] } | { error: string } {
  if (bytes.length > THEME_LIMITS.svgBytes) {
    return { error: `SVG is larger than ${THEME_LIMITS.svgBytes} bytes` };
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: "SVG is not valid UTF-8" };
  }

  const parts: string[] = [];
  const usesXlink = { value: false };
  let xlinkAt = -1;
  let depth = 0;
  /** Depth at which a dropped foreign element started; 0 when not inside one. */
  let skipFrom = 0;
  /** The last emitted start tag still lacks its `>`. */
  let openPending = false;
  let sawRoot = false;
  let rootBox: [number, number, number, number] = [0, 0, 0, 0];
  const closePending = () => {
    if (openPending) parts.push(">");
    openPending = false;
  };

  const parser = new SaxesParser({ xmlns: true, position: true });
  parser.on("error", (e) => reject(`SVG is not valid XML: ${e.message}`));
  parser.on("doctype", () => reject("SVG must not contain a DOCTYPE or entity declarations"));
  parser.on("processinginstruction", () => reject("SVG must not contain processing instructions"));
  parser.on("xmldecl", (d) => {
    if (d.encoding !== undefined && !/^utf-?8$/i.test(d.encoding)) {
      reject(`SVG must be encoded as UTF-8, not ${d.encoding}`);
    }
  });
  parser.on("opentag", (tag) => {
    depth += 1;
    if (skipFrom > 0) return;
    const isRoot = !sawRoot;
    sawRoot = true;
    if (tag.uri === XHTML_NS) reject(`XHTML element <${tag.name}> is not allowed`);
    if (isRoot) {
      if (tag.local !== "svg") reject("the root element must be <svg>");
      if (tag.uri !== SVG_NS) reject(`the root <svg> must be in the SVG namespace (${SVG_NS})`);
      const viewBox = Object.values(tag.attributes).find(
        (a) => a.uri === "" && a.local === "viewBox",
      );
      if (viewBox === undefined) reject("the root <svg> must have a viewBox");
      else {
        const box = parseViewBox(viewBox.value);
        if (box === undefined) {
          reject("the root <svg> viewBox must be four numbers with a positive width and height");
        } else rootBox = box;
      }
    }
    if (tag.uri !== SVG_NS) {
      skipFrom = depth;
      return;
    }
    if (!SVG_ELEMENTS.has(tag.local)) reject(`element <${tag.local}> is not allowed`);
    closePending();
    parts.push(`<${tag.local}`);
    if (isRoot) {
      parts.push(` xmlns="${SVG_NS}"`);
      xlinkAt = parts.length;
      parts.push("");
    }
    parts.push(attributesOf(tag, isRoot, usesXlink));
    openPending = true;
  });
  parser.on("closetag", (tag) => {
    depth -= 1;
    if (skipFrom > 0) {
      if (depth < skipFrom) skipFrom = 0;
      return;
    }
    if (openPending) {
      parts.push("/>");
      openPending = false;
    } else {
      parts.push(`</${tag.local}>`);
    }
  });
  const onText = (t: string) => {
    if (depth === 0 || skipFrom > 0 || t === "") return;
    closePending();
    parts.push(escapeText(t));
  };
  parser.on("text", onText);
  parser.on("cdata", onText);

  try {
    parser.write(source).close();
  } catch (e) {
    if (e instanceof SvgRejected) return { error: e.message };
    return { error: `SVG is not valid XML: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!sawRoot) return { error: "the root element must be <svg>" };
  if (usesXlink.value) parts[xlinkAt] = ` xmlns:xlink="${XLINK_NS}"`;
  return { svg: parts.join(""), viewBox: rootBox };
}

const startsWith = (bytes: Uint8Array, sig: readonly number[]) =>
  bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);

const WOFF2_SIG = [0x77, 0x4f, 0x46, 0x32]; // "wOF2"
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

/** A woff2 font: the `wOF2` signature and at most {@link THEME_LIMITS}`.fontBytes`. */
export function checkWoff2(bytes: Uint8Array): string | undefined {
  if (bytes.length > THEME_LIMITS.fontBytes) {
    return `font is larger than ${THEME_LIMITS.fontBytes} bytes`;
  }
  if (!startsWith(bytes, WOFF2_SIG)) return "font is not a woff2 file (no wOF2 signature)";
  return undefined;
}

/**
 * A PNG logo: the PNG signature, an `IHDR` first chunk with a height of at least
 * {@link THEME_LIMITS}`.pngMinHeight` pixels, and at most {@link THEME_LIMITS}`.pngBytes`.
 */
export function checkPng(bytes: Uint8Array): string | undefined {
  const r = readPng(bytes);
  return typeof r === "string" ? r : undefined;
}

/** {@link checkPng}, returning the IHDR size when the PNG passes. */
function readPng(bytes: Uint8Array): { width: number; height: number } | string {
  if (bytes.length > THEME_LIMITS.pngBytes) {
    return `PNG is larger than ${THEME_LIMITS.pngBytes} bytes`;
  }
  if (!startsWith(bytes, PNG_SIG)) return "image is not a PNG file (no PNG signature)";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24 || view.getUint32(8) !== 13 || !IHDR.every((b, i) => bytes[12 + i] === b)) {
    return "PNG has no valid IHDR header";
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0) return "PNG has a width of 0";
  if (height < THEME_LIMITS.pngMinHeight) {
    return `PNG must be at least ${THEME_LIMITS.pngMinHeight} px high, not ${height}`;
  }
  return { width, height };
}

/**
 * Resolves and checks the asset files of a parsed theme: each `fonts[].file` ({@link checkWoff2})
 * and `logo.mark` / `logo.favicon` (`.svg` through {@link sanitizeThemeSvg}, `.png` through
 * {@link checkPng}); the favicon must be square (SVG viewBox or PNG width = height). `files` holds the plugin's files keyed by their path without a leading
 * `./`; the returned `assets` (the sanitized SVG bytes, the other files unchanged) use the same
 * keys. Errors are `<field>: <reason>`, English; the total input size of the theme's distinct
 * assets must stay within {@link THEME_LIMITS}`.assetsBytes`. That limit is per plugin, so a
 * caller reading several themes also checks the sum over all of them (distinct paths).
 */
export function validateThemeAssets(
  theme: ParsedTheme,
  files: Map<string, Uint8Array>,
): { assets: Map<string, Uint8Array>; errors: string[] } {
  const assets = new Map<string, Uint8Array>();
  const errors: string[] = [];
  const sizes = new Map<string, number>();

  const resolve = (field: string, ref: string, check: (b: Uint8Array) => Uint8Array | string) => {
    const path = ref.replace(/^\.\//, "");
    if (!isSafePackagePath(path)) {
      errors.push(`${field}: ${ref} must be a relative path inside the plugin`);
      return;
    }
    const bytes = files.get(path);
    if (bytes === undefined) {
      errors.push(`${field}: ${ref} not found in the plugin`);
      return;
    }
    const r = check(bytes);
    if (typeof r === "string") {
      errors.push(`${field}: ${ref}: ${r}`);
      return;
    }
    sizes.set(path, bytes.length);
    assets.set(path, r);
  };

  const font = (b: Uint8Array) => checkWoff2(b) ?? b;
  const image = (ref: string, square: boolean) => (b: Uint8Array) => {
    const notSquare = (w: number, h: number) => `favicon must be square, not ${w} x ${h}`;
    if (/\.png$/i.test(ref)) {
      const r = readPng(b);
      if (typeof r === "string") return r;
      return square && r.width !== r.height ? notSquare(r.width, r.height) : b;
    }
    if (!/\.svg$/i.test(ref)) return "must be a .svg or .png file";
    const r = sanitize(b);
    if ("error" in r) return r.error;
    const [, , w, h] = r.viewBox;
    return square && w !== h ? notSquare(w, h) : new TextEncoder().encode(r.svg);
  };

  theme.fonts?.forEach((f, i) => {
    resolve(`fonts.${i}.file`, f.file, font);
  });
  for (const key of ["mark", "favicon"] as const) {
    const ref = theme.logo?.[key];
    if (ref !== undefined) resolve(`logo.${key}`, ref, image(ref, key === "favicon"));
  }

  let total = 0;
  for (const n of sizes.values()) total += n;
  if (total > THEME_LIMITS.assetsBytes) {
    errors.push(
      `theme assets are larger than ${THEME_LIMITS.assetsBytes} bytes in total (${total})`,
    );
  }
  return { assets, errors };
}
