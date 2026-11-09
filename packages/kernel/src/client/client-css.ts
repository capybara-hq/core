/**
 * The import check of a client stylesheet (client extensions spec §4.1, §7.2): the packer wraps
 * every file in `@layer extensions { … }`, refuses `@import` and lets a URL name only an asset of
 * the plugin (`../assets/<path>`, a file of `client.assets`), a `data:` URL or a `#fragment`; the
 * kernel re-checks the stored bytes, because a tgz can be written by hand. Any other URL, relative
 * ones included, is refused: the stylesheet is served from `/api/v1/client/<plugin>/<build>/styles/`,
 * so `../../../../…` would reach the kernel's own routes with the viewer's cookies.
 *
 * Two checks, both must pass:
 * - {@link cssRemoteProblem}: the packer's rule (`capybara-plugin`, `pack/client.ts`), kept the
 *   same so a file the packer refuses is refused here too;
 * - a tokenizer that follows the CSS Syntax tokenization (comments, strings, escapes, url tokens)
 *   closely enough that every brace it skips is one a browser skips too: the file must start with
 *   `@layer extensions {` and the block that opens must close at the file's last character, so no
 *   rule lands outside the layer. Every `url(…)` (token or string) is checked after decoding
 *   escapes, and an `@import` at-keyword is refused however it is spelled.
 *
 * Two rules close the spellings a plain string check would miss, in both checks and in the packer:
 * - URLs are trimmed with CSS whitespace only (space, tab, LF, CR, FF), and a file holding any other
 *   whitespace, a zero-width character (U+200B-U+200D, U+2060) or U+FEFF anywhere, escaped or not,
 *   is refused: JavaScript's `trim()` strips an NBSP that CSS and the URL parser keep, so
 *   `url("\a0 data:/../../v1")` would pass as `data:` and resolve to `/api/v1`;
 * - functions that turn a plain string (or a `var()`) into a URL or reach outside the stylesheet are
 *   refused outright ({@link REFUSED_FUNCTIONS}): `image-set(var(--u) 1x)` takes its URL from a
 *   custom property no string check can see. Plugins write `url(../assets/x)` directly.
 */

/** CSS whitespace (CSS Syntax §4.2): only these are trimmed from a URL. */
const CSS_SPACE = "[ \\t\\n\\r\\f]";
const CSS_TRIM = new RegExp(`^${CSS_SPACE}+|${CSS_SPACE}+$`, "g");
const cssTrim = (s: string) => s.replace(CSS_TRIM, "");

/** Whitespace other than CSS's, zero-width characters and U+FEFF: refused anywhere in a file. */
const INVISIBLE_RE =
  /[\u0085\u00a0\u1680\u180e\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/;

const INVISIBLE_REFUSED =
  "the stylesheet contains non-ASCII whitespace, a zero-width character or U+FEFF; use plain spaces";

/**
 * Functions refused in a client stylesheet (case-insensitive, escapes decoded): they take URLs from
 * plain strings or `var()` (`image-set`, `cross-fade`, `src`, `image`), or reach outside it
 * (`element`, `paint`).
 */
const REFUSED_FUNCTIONS = new Set([
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "-webkit-cross-fade",
  "element",
  "-moz-element",
  "paint",
  "src",
  "image",
]);

const REFUSED_FUNCTION_RE =
  /(?<![A-Za-z0-9_-])(-webkit-image-set|image-set|-webkit-cross-fade|cross-fade|-moz-element|element|paint|src|image)\(/i;

const functionRefused = (name: string) =>
  `${name}() is not allowed in a client stylesheet; use url(../assets/<file>) directly`;

/**
 * The packer's rule (mirrors `cssRemoteProblem` of `@capybara-hq/plugin-tools`), escapes decoded
 * first: no invisible characters (see the file header), no {@link REFUSED_FUNCTIONS}, no
 * `@import`, and every `url()` is {@link cssUrlProblem}-free. `assets` are the plugin's asset paths
 * relative to `assets/` (`a.png`, `fx/boot.ogg`). Returns the problem, or undefined.
 */
export function cssRemoteProblem(css: string, assets: ReadonlySet<string>): string | undefined {
  const bare = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})[ \t\n]?|\\([^\n])/gi, (_m, hex?: string, ch?: string) => {
      if (hex === undefined) return ch ?? "";
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    });
  if (INVISIBLE_RE.test(css) || INVISIBLE_RE.test(bare)) return INVISIBLE_REFUSED;
  const fn = REFUSED_FUNCTION_RE.exec(bare);
  if (fn !== null) return functionRefused((fn[1] as string).toLowerCase());
  if (/@import\b/i.test(bare)) return IMPORT_REFUSED;
  for (const m of bare.matchAll(/url\([ \t\n\r\f]*(["']?)([^)"']*)\1[ \t\n\r\f]*\)/gi)) {
    const problem = cssUrlProblem(cssTrim(m[2] ?? ""), assets);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

const IMPORT_REFUSED =
  "@import is not allowed (a remote stylesheet is not integrity-pinned); inline the rules";

/** How a stylesheet names one of the plugin's assets (it is served from `styles/`). */
const ASSETS_URL = "../assets/";

/**
 * The problem of one URL of a stylesheet (escapes decoded, CSS whitespace trimmed), or undefined
 * when it is a `#fragment`, a `data:` URL or `../assets/<path>` naming one of `assets` exactly.
 */
export function cssUrlProblem(u: string, assets: ReadonlySet<string>): string | undefined {
  if (u.startsWith("#") || /^data:/i.test(u)) return undefined;
  if (u.startsWith(ASSETS_URL) && assets.has(u.slice(ASSETS_URL.length))) return undefined;
  return `url(${u}) is not allowed; use ../assets/<a file of client/assets>, a data: URL or a #fragment`;
}

const WRAP_RE = /^@layer extensions \{/;

const isNewline = (c: string | undefined) => c === "\n" || c === "\r" || c === "\f";
const isWhitespace = (c: string | undefined) => c === " " || c === "\t" || isNewline(c);
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-f]$/i.test(c);
/** A name code point (CSS Syntax §4.2): letters, digits, `-`, `_`, anything non-ASCII. */
const isNameChar = (c: string | undefined) =>
  c !== undefined && (/^[A-Za-z0-9_-]$/.test(c) || (c.codePointAt(0) as number) >= 0x80);

class CssProblem extends Error {}

/** Tokenizes `css` from `start`; see the file header. */
class Scanner {
  private i: number;
  /** Open `{` blocks; the layer block is the first. */
  private depth = 1;
  /** Open function / parenthesis names ("" for a plain `(` or `[`), innermost last. */
  private readonly fns: string[] = [];

  constructor(
    private readonly css: string,
    start: number,
    private readonly assets: ReadonlySet<string>,
  ) {
    this.i = start;
  }

  run(): void {
    const s = this.css;
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (c === "/" && s[this.i + 1] === "*") {
        const end = s.indexOf("*/", this.i + 2);
        if (end < 0) throw new CssProblem("a comment is not closed");
        this.i = end + 2;
      } else if (c === '"' || c === "'") {
        const value = this.string(c);
        if (this.fns[this.fns.length - 1] === "url") {
          const problem = cssUrlProblem(cssTrim(value), this.assets);
          if (problem !== undefined) throw new CssProblem(problem);
        }
      } else if (c === "@") {
        this.i++;
        if (this.startsName()) {
          if (this.name().toLowerCase() === "import") throw new CssProblem(IMPORT_REFUSED);
        }
      } else if (c === "#") {
        this.i++;
        if (this.startsName()) this.name();
      } else if (this.startsName()) {
        const name = this.name().toLowerCase();
        if (s[this.i] === "(") {
          this.i++;
          if (REFUSED_FUNCTIONS.has(name)) throw new CssProblem(functionRefused(name));
          if (name === "url" && !this.quoteAfterWhitespace()) this.urlToken();
          else this.fns.push(name);
        }
      } else if (c === "(" || c === "[") {
        this.fns.push("");
        this.i++;
      } else if (c === ")" || c === "]") {
        this.fns.pop();
        this.i++;
      } else if (c === "{") {
        this.depth++;
        this.i++;
      } else if (c === "}") {
        this.depth--;
        this.i++;
        if (this.depth === 0) {
          if (cssTrim(s.slice(this.i)) !== "") {
            throw new CssProblem(
              "a rule is outside @layer extensions; the whole file must be one @layer extensions block",
            );
          }
          return;
        }
      } else {
        this.i++;
      }
    }
    throw new CssProblem("the @layer extensions block is not closed");
  }

  /** Whether a name starts here: a name code point or a valid escape. */
  private startsName(): boolean {
    const s = this.css;
    const c = s[this.i];
    return isNameChar(c) || (c === "\\" && this.i + 1 < s.length && !isNewline(s[this.i + 1]));
  }

  /** A valid escape at `this.i` (the backslash); returns the decoded character. */
  private escape(): string {
    const s = this.css;
    this.i++; // the backslash
    if (isHex(s[this.i])) {
      let hex = "";
      while (hex.length < 6 && isHex(s[this.i])) hex += s[this.i++];
      if (s[this.i] === "\r" && s[this.i + 1] === "\n") this.i += 2;
      else if (isWhitespace(s[this.i])) this.i++;
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
        ? String.fromCodePoint(cp)
        : "�";
    }
    const cp = s.codePointAt(this.i);
    if (cp === undefined) return "�";
    const ch = String.fromCodePoint(cp);
    this.i += ch.length;
    return ch;
  }

  /** Consumes a name (name code points and valid escapes), decoded. */
  private name(): string {
    const s = this.css;
    let out = "";
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (isNameChar(c)) {
        out += c;
        this.i++;
      } else if (c === "\\" && this.i + 1 < s.length && !isNewline(s[this.i + 1])) {
        out += this.escape();
      } else break;
    }
    return out;
  }

  /** A string from its opening quote; an unescaped newline or the end of the file refuses. */
  private string(quote: string): string {
    const s = this.css;
    this.i++;
    let out = "";
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (c === quote) {
        this.i++;
        return out;
      }
      if (isNewline(c)) throw new CssProblem("a string is not closed on its line");
      if (c === "\\") {
        const next = s[this.i + 1];
        if (next === undefined) break;
        if (isNewline(next)) {
          this.i += next === "\r" && s[this.i + 2] === "\n" ? 3 : 2;
        } else out += this.escape();
      } else {
        out += c;
        this.i++;
      }
    }
    throw new CssProblem("a string is not closed");
  }

  /** After `url(`: whether the argument is a string (then `url(` is an ordinary function). */
  private quoteAfterWhitespace(): boolean {
    const s = this.css;
    let j = this.i;
    while (isWhitespace(s[j])) j++;
    return s[j] === '"' || s[j] === "'";
  }

  /**
   * An unquoted url token after `url(`: everything up to the first unescaped `)` (a bad url, with a
   * quote or `(` inside, ends there too), escapes decoded; the URL is checked.
   */
  private urlToken(): void {
    const s = this.css;
    let out = "";
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (c === ")") {
        this.i++;
        const problem = cssUrlProblem(cssTrim(out), this.assets);
        if (problem !== undefined) throw new CssProblem(problem);
        return;
      }
      if (c === "\\" && this.i + 1 < s.length && !isNewline(s[this.i + 1])) out += this.escape();
      else {
        out += c;
        this.i++;
      }
    }
    throw new CssProblem("a url( is not closed");
  }
}

/**
 * The problem of a client stylesheet as stored (see the file header), or undefined when it is one
 * `@layer extensions` block with no `@import` and every URL a `#fragment`, a `data:` URL or one of
 * the plugin's `assets` (paths relative to `assets/`).
 */
export function clientCssProblem(css: string, assets: ReadonlySet<string>): string | undefined {
  const remote = cssRemoteProblem(css, assets);
  if (remote !== undefined) return remote;
  const wrap = WRAP_RE.exec(css);
  if (wrap === null) {
    return "the file must start with @layer extensions { (capybara-plugin pack wraps every stylesheet)";
  }
  try {
    new Scanner(css, wrap[0].length, assets).run();
  } catch (e) {
    if (e instanceof CssProblem) return e.message;
    throw e;
  }
  return undefined;
}
