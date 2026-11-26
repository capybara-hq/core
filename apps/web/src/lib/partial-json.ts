// Tolerant parser for a tool call's input JSON while it streams: every prefix of a valid JSON
// object yields the object as far as it has arrived. Trailing incomplete tokens (a dangling key,
// a half-written literal or number, an unfinished escape, half of a surrogate pair) are dropped;
// an unterminated string keeps the text received so far. Never throws.

export interface PartialJson {
  /** The parsed top-level object, or null while nothing object-shaped has arrived. */
  value: Record<string, unknown> | null;
  /** The top-level string property that is still receiving text, if any. */
  open: string | null;
}

interface Parsed {
  /** `undefined` means nothing usable arrived for this value yet. */
  value: unknown;
  /** True when the value ended inside the text (so parsing may continue after it). */
  complete: boolean;
}

const NOTHING: Parsed = { value: undefined, complete: false };
const WS = /\s/;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function parsePartialJson(text: string): PartialJson {
  let pos = 0;
  let open: string | null = null;

  const skipWs = (): void => {
    while (pos < text.length && WS.test(text[pos] as string)) pos++;
  };

  // Reads a string starting at the opening quote. Returns the text so far and whether the
  // closing quote was seen.
  const readString = (): { text: string; complete: boolean } => {
    pos++;
    let out = "";
    while (pos < text.length) {
      const ch = text[pos] as string;
      if (ch === '"') {
        pos++;
        return { text: out, complete: true };
      }
      if (ch !== "\\") {
        out += ch;
        pos++;
        continue;
      }
      const esc = text[pos + 1];
      if (esc === undefined) break;
      if (esc === "u") {
        const hex = text.slice(pos + 2, pos + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        pos += 6;
        continue;
      }
      out += SIMPLE_ESCAPES[esc] ?? esc;
      pos += 2;
    }
    // Unterminated: a high surrogate at the end is half a pair, drop it.
    if (out.length > 0 && isHighSurrogate(out.charCodeAt(out.length - 1))) out = out.slice(0, -1);
    return { text: out, complete: false };
  };

  const parseObject = (top: boolean): Parsed => {
    const obj: Record<string, unknown> = {};
    pos++;
    for (;;) {
      skipWs();
      if (pos >= text.length) return { value: obj, complete: false };
      if (text[pos] === "}") {
        pos++;
        return { value: obj, complete: true };
      }
      if (text[pos] !== '"') return { value: obj, complete: false };
      const key = readString();
      if (!key.complete) return { value: obj, complete: false };
      skipWs();
      if (text[pos] !== ":") return { value: obj, complete: false };
      pos++;
      skipWs();
      const isString = text[pos] === '"';
      const child = parseValue(false);
      if (child.value !== undefined) {
        obj[key.text] = child.value;
        if (top && isString && !child.complete) open = key.text;
      }
      if (!child.complete) return { value: obj, complete: false };
      skipWs();
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "}") {
        pos++;
        return { value: obj, complete: true };
      }
      return { value: obj, complete: false };
    }
  };

  const parseArray = (): Parsed => {
    const arr: unknown[] = [];
    pos++;
    for (;;) {
      skipWs();
      if (pos >= text.length) return { value: arr, complete: false };
      if (text[pos] === "]") {
        pos++;
        return { value: arr, complete: true };
      }
      const child = parseValue(false);
      if (child.value !== undefined) arr.push(child.value);
      if (!child.complete) return { value: arr, complete: false };
      skipWs();
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "]") {
        pos++;
        return { value: arr, complete: true };
      }
      return { value: arr, complete: false };
    }
  };

  const parseValue = (top: boolean): Parsed => {
    skipWs();
    if (pos >= text.length) return NOTHING;
    const ch = text[pos] as string;
    if (ch === "{") return parseObject(top);
    if (ch === "[") return parseArray();
    if (ch === '"') {
      const s = readString();
      return { value: s.text, complete: s.complete };
    }
    const start = pos;
    while (pos < text.length && !/[\s,\]}:]/.test(text[pos] as string)) pos++;
    const token = text.slice(start, pos);
    const atEnd = pos >= text.length;
    if (token === "true") return { value: true, complete: true };
    if (token === "false") return { value: false, complete: true };
    if (token === "null") return { value: null, complete: true };
    if (NUMBER.test(token)) return { value: Number(token), complete: !atEnd };
    // A half-written literal or number, or malformed input: nothing usable, stop here.
    pos = text.length;
    return NOTHING;
  };

  skipWs();
  if (text[pos] !== "{") return { value: null, open: null };
  const root = parseObject(true);
  return { value: root.value as Record<string, unknown>, open };
}
