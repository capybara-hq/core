// Token-like text in a composer draft (setup guides v2 spec §12.1): a guard against pasting a
// secret into a conversation, not a security boundary. Pure and browser-only: nothing is logged,
// reported or sent anywhere.

export type TokenLikeKind =
  | "slack-token"
  | "slack-app-token"
  | "github-token"
  | "api-key"
  | "aws-key"
  | "google-key"
  | "private-key"
  | "jwt"
  | "high-entropy";

export type TokenLikeSpan = { start: number; end: number; kind: TokenLikeKind };

/** Nothing that can continue a token comes right before a match (a word boundary for tokens). */
const B = "(?<![0-9A-Za-z_-])";
/** Nothing that can continue the tail comes right after a fixed-length match. */
const E = "(?![0-9A-Za-z_-])";

const PATTERNS: { kind: TokenLikeKind; re: RegExp; needsDigit?: boolean }[] = [
  { kind: "slack-token", re: new RegExp(`${B}xox[bpaer]-[0-9A-Za-z-]{10,}`, "g") },
  { kind: "slack-app-token", re: new RegExp(`${B}xapp-[0-9]-[0-9A-Za-z-]{10,}`, "g") },
  { kind: "github-token", re: new RegExp(`${B}gh[pousr]_[0-9A-Za-z]{36}${E}`, "g") },
  { kind: "github-token", re: new RegExp(`${B}github_pat_[0-9A-Za-z_]{22,}`, "g") },
  // `sk-ant-…`, `sk-proj-…`; real keys always hold a digit, a long kebab-case word never does
  { kind: "api-key", re: new RegExp(`${B}sk-[0-9A-Za-z_-]{20,}`, "g"), needsDigit: true },
  { kind: "aws-key", re: new RegExp(`${B}AKIA[0-9A-Z]{16}${E}`, "g") },
  { kind: "google-key", re: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}${E}`, "g") },
  // the whole block when its END line is there (Remove then takes the key body too)
  {
    kind: "private-key",
    re: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----(?:[\s\S]*?-----END \1PRIVATE KEY-----)?/g,
  },
  {
    kind: "jwt",
    re: new RegExp(`${B}eyJ[0-9A-Za-z_-]{10,}\\.[0-9A-Za-z_-]{10,}\\.[0-9A-Za-z_-]{10,}`, "g"),
  },
];

/** A run of base64 / base64url characters, the candidates for the entropy rule. */
const RUN = /[A-Za-z0-9+/=_-]{32,}/g;
const MIN_ENTROPY = 4.0;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const HEX_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Subresource integrity (`sha512-…` in a lockfile): a public hash, not a secret. */
const SRI = /^sha(?:1|256|384|512)-/;

/** Shannon entropy of `s`, in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Fenced (```) and inline (`) code spans: [start, end) of their content. */
function codeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const fence = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  // the text with the fences blanked out, for the inline spans
  let outside = "";
  let last = 0;
  for (let m = fence.exec(text); m !== null; m = fence.exec(text)) {
    if (m[0].length === 0) {
      fence.lastIndex++;
      continue;
    }
    const body = m[1] ?? "";
    const bodyStart = m.index + m[0].indexOf(body, 3);
    spans.push([bodyStart, bodyStart + body.length]);
    outside += text.slice(last, m.index) + m[0].replace(/[^\n]/g, " ");
    last = m.index + m[0].length;
  }
  outside += text.slice(last);
  const inline = /`([^`\n]+)`/g;
  for (let m = inline.exec(outside); m !== null; m = inline.exec(outside)) {
    spans.push([m.index + 1, m.index + 1 + (m[1] ?? "").length]);
  }
  return spans;
}

/** Code with words (`const x = …`), not a span that only quotes the token. */
function holdsWords(content: string): boolean {
  return content.trim().split(/\s+/).length >= 2;
}

/** What comes before `start` in its whitespace-delimited chunk (`https://host` before a path). */
function chunkBefore(text: string, start: number): string {
  let s = start;
  while (s > 0 && !/\s/.test(text[s - 1] ?? "")) s--;
  return text.slice(s, start);
}

/** Path segments (`a/very/long/path`) rather than base64 that happens to hold a `/`. */
function looksLikePath(run: string): boolean {
  if (!run.includes("/")) return false;
  const segs = run.split("/").filter((s) => s !== "");
  if (segs.length < 3) return false;
  const wordy = segs.filter((s) => /^(?:[A-Za-z][A-Za-z_-]*[0-9]*|[0-9]+)$/.test(s)).length;
  return wordy * 2 >= segs.length;
}

/**
 * Words joined into one run: an identifier (`snake_case_name_2`, `kebab-case-slug`,
 * `camelCaseTestName`), an env line (`CAPYBARA_X__POOL_SIZE=3`) or a package path
 * (`capybara-hq/plugin-object-store-s3`). Its words average 3.5 letters or more, at most 30% of
 * them single letters, where a random string splits into one- and two-letter bits.
 */
function looksLikeWords(run: string): boolean {
  const words = run.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g) ?? [];
  const letters = words.filter((w) => /[A-Za-z]/.test(w));
  if (letters.length < 3) return false;
  const avg = letters.reduce((n, w) => n + w.length, 0) / letters.length;
  const tiny = letters.filter((w) => w.length === 1).length;
  return avg >= 3.5 && tiny * 10 <= letters.length * 3;
}

/** An alphabet in code (`abcdefghijklmnopqrstuvwxyz0123456789`), not a secret. */
const ALPHABET = /abcdefgh|ABCDEFGH|23456789/;
/** Raw base64 of a file (PNG, JPEG, GIF, PDF, zip) pasted without its `data:` prefix. */
const FILE_MAGIC = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|JVBERi0|UEsDB)/;

function highEntropy(text: string, run: string, start: number): boolean {
  if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) return false;
  if (HEX_HASH.test(run) || SRI.test(run)) return false;
  // ids built around UUIDs (`agent_<uuid>`, two UUIDs joined)
  const uuidFree = run.replace(UUID, "");
  if (uuidFree !== run && uuidFree.replace(/[_-]/g, "").length < 16) return false;
  const before = chunkBefore(text, start);
  if (/[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(before) || /^www\./i.test(before)) return false;
  if (/(?:^|[^A-Za-z])data:/i.test(before)) return false;
  if (ALPHABET.test(run) || FILE_MAGIC.test(run)) return false;
  if (looksLikePath(run) || looksLikeWords(run)) return false;
  return shannonEntropy(run) >= MIN_ENTROPY;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

/**
 * The spans of `text` that look like a credential, in order and never overlapping: the vendor
 * patterns first, then long high-entropy runs (≥ 32 base64url characters, ≥ 4.0 bits per character,
 * a digit and a letter) that are not a URL, a `data:` URI, a path, an identifier, a UUID, a hex
 * hash or part of a code span holding words.
 */
export function findTokenLikeSpans(text: string): TokenLikeSpan[] {
  const found: TokenLikeSpan[] = [];
  for (const { kind, re, needsDigit } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (needsDigit && !/[0-9]/.test(m[0].slice(3))) continue;
      const span = { start: m.index, end: m.index + m[0].length, kind };
      if (!found.some((f) => overlaps(f, span))) found.push(span);
    }
  }
  const code = codeSpans(text).filter(([s, e]) => holdsWords(text.slice(s, e)));
  RUN.lastIndex = 0;
  for (let m = RUN.exec(text); m !== null; m = RUN.exec(text)) {
    const span = { start: m.index, end: m.index + m[0].length, kind: "high-entropy" as const };
    if (found.some((f) => overlaps(f, span))) continue;
    if (code.some(([s, e]) => span.start >= s && span.end <= e)) continue;
    if (highEntropy(text, m[0], span.start)) found.push(span);
  }
  return found.sort((a, b) => a.start - b.start);
}

/** `text` without `spans` (the warning's Remove). */
export function removeSpans(text: string, spans: readonly TokenLikeSpan[]): string {
  let out = "";
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at) continue;
    out += text.slice(at, s.start);
    at = s.end;
  }
  return out + text.slice(at);
}
