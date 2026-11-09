/**
 * The import check of a client stylesheet (client extensions spec §4.1, §7.2): the packer wraps
 * every file in `@layer extensions { … }` and refuses `@import` and absolute `url()`; the kernel
 * re-checks the stored bytes, because a tgz can be written by hand.
 *
 * Two checks, both must pass:
 * - {@link cssRemoteProblem}: the packer's rule (`capybara-plugin`, `pack/client.ts`), kept the
 *   same so a file the packer refuses is refused here too;
 * - a tokenizer that follows the CSS Syntax tokenization (comments, strings, escapes, url tokens)
 *   closely enough that every brace it skips is one a browser skips too: the file must start with
 *   `@layer extensions {` and the block that opens must close at the file's last character, so no
 *   rule lands outside the layer. Every `url(…)`, and every string inside `url()`, `src()`,
 *   `image()`, `image-set()` and `cross-fade()`, is checked after decoding escapes, and an
 *   `@import` at-keyword is refused however it is spelled.
 */

/**
 * The packer's rule (mirrors `cssRemoteProblem` of `@capybara-hq/plugin-tools`): no `@import`, no
 * absolute `url()` (only relative paths, `#` fragments and `data:`), escapes decoded first, strings
 * of `image-set()` included. Returns the problem, or undefined.
 */
export function cssRemoteProblem(css: string): string | undefined {
  const bare = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})[ \t\n]?|\\([^\n])/gi, (_m, hex?: string, ch?: string) => {
      if (hex === undefined) return ch ?? "";
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    });
  if (/@import\b/i.test(bare)) return IMPORT_REFUSED;
  for (const m of bare.matchAll(/url\(\s*(["']?)([^)"']*)\1\s*\)/gi)) {
    const u = (m[2] ?? "").trim();
    if (isRemoteUrl(u)) return urlRefused(u);
  }
  for (const m of bare.matchAll(/(?:-webkit-)?image-set\(([^;{}]*)\)/gi)) {
    for (const q of (m[1] ?? "").matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const u = (q[2] ?? "").trim();
      if (isRemoteUrl(u)) return urlRefused(u);
    }
  }
  return undefined;
}

const IMPORT_REFUSED =
  "@import is not allowed (a remote stylesheet is not integrity-pinned); inline the rules";

const urlRefused = (u: string) =>
  `url(${u}) is not allowed; use a relative path under ../assets/ or a data: URL`;

/** Absolute or remote: a scheme other than `data:`, a protocol-relative or a root-relative URL. */
function isRemoteUrl(u: string): boolean {
  return (
    u !== "" &&
    !/^data:/i.test(u) &&
    !u.startsWith("#") &&
    (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//") || u.startsWith("/"))
  );
}

/** Functions whose string arguments are URLs. */
const URL_FUNCTIONS = new Set([
  "url",
  "src",
  "image",
  "image-set",
  "-webkit-image-set",
  "cross-fade",
]);

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
        if (this.fns.some((f) => URL_FUNCTIONS.has(f)) && isRemoteUrl(value.trim())) {
          throw new CssProblem(urlRefused(value.trim()));
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
          if (s.slice(this.i).trim() !== "") {
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
        const u = out.trim();
        if (isRemoteUrl(u)) throw new CssProblem(urlRefused(u));
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
 * `@layer extensions` block with no `@import` and no absolute or remote URL.
 */
export function clientCssProblem(css: string): string | undefined {
  const remote = cssRemoteProblem(css);
  if (remote !== undefined) return remote;
  const wrap = WRAP_RE.exec(css);
  if (wrap === null) {
    return "the file must start with @layer extensions { (capybara-plugin pack wraps every stylesheet)";
  }
  try {
    new Scanner(css, wrap[0].length).run();
  } catch (e) {
    if (e instanceof CssProblem) return e.message;
    throw e;
  }
  return undefined;
}
