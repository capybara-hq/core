import type { Logger, ToolInputView } from "@capybara-hq/plugin-sdk";
import type { ResolvedTool } from "../tools/registry.js";

/**
 * The `Write` base (streaming tool input spec §4.1, D7): while the model streams a call whose tool
 * declares `inputView.kind: "file_write"`, once its path string has closed, the kernel reads the
 * file's current content once, for display only, and publishes it as a `tool_base` so the web can
 * show a live diff. Everything here fails closed: any doubt gives no base, never an error to the
 * run, and nothing reaches the model, the log or a hook. This file holds the stream side (the path
 * scanner and the watcher); the device read is `write-base.service.ts`, kept apart so the model
 * step imports nothing of the sandbox.
 */

/** The longest raw (still escaped) top-level key the scanner keeps: longer ones match no property. */
const KEY_MAX_CHARS = 256;
/** The longest raw (still escaped) property value the scanner keeps: a longer path gets no base. */
const VALUE_MAX_CHARS = 8192;
/**
 * How long an attempt waits for its base reads after aborting them. The abort reaches the lease
 * and provider waits, so a read normally ends at once; a provider that ignores its signal never
 * holds the step (and a Stop) past this bound for a display-only base.
 */
export const WRITE_BASE_SETTLE_MS = 3_000;

/**
 * Reads the value of one top-level string property of a JSON object streamed in fragments, without
 * re-reading the buffer: each {@link feed} scans only the new fragment with the carried state.
 * The value is known once its closing quote arrived (a half path is not a path). A property of a
 * nested object or array, a non-string value, a top level that is not an object, or a value
 * above {@link VALUE_MAX_CHARS} gives nothing.
 */
export class TopLevelStringProperty {
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** At depth 1, the next string is a key. */
  private expectKey = false;
  /** What the string being read is. */
  private role: "key" | "value" | "other" = "other";
  /** The raw text of the key or value being read (between its quotes). */
  private raw = "";
  /** The top-level key read last, until its `:`; null when unknown or too long. */
  private key: string | null = null;
  /** The key whose value comes next at depth 1. */
  private valueOf: string | null = null;
  private result: string | null = null;
  private done = false;

  constructor(private readonly prop: string) {}

  /** Scans `fragment`; returns the property's value once known, null before (and when none). */
  feed(fragment: string): string | null {
    if (this.done) return this.result;
    for (const c of fragment) {
      this.step(c);
      if (this.done) break;
    }
    return this.result;
  }

  private step(c: string): void {
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
        this.keep(c);
      } else if (c === "\\") {
        this.escaped = true;
        this.keep(c);
      } else if (c === '"') {
        this.closeString();
      } else {
        this.keep(c);
      }
      return;
    }
    switch (c) {
      case '"':
        this.inString = true;
        this.raw = "";
        if (this.depth === 1 && this.expectKey) this.role = "key";
        else if (this.depth === 1 && this.valueOf === this.prop) this.role = "value";
        else this.role = "other";
        return;
      case "{":
      case "[":
        // the top level must be an object
        if (this.depth === 0 && c === "[") {
          this.stop();
          return;
        }
        if (this.depth === 1) this.valueOf = null;
        this.depth++;
        if (this.depth === 1) this.expectKey = true;
        return;
      case "}":
      case "]":
        this.depth--;
        // the object ended without the property
        if (this.depth <= 0) this.stop();
        return;
      case ":":
        if (this.depth === 1) {
          this.valueOf = this.key;
          this.key = null;
          this.expectKey = false;
        }
        return;
      case ",":
        if (this.depth === 1) {
          this.expectKey = true;
          this.valueOf = null;
        }
        return;
      default:
        // a number, literal or whitespace; a non-string value of the property ends the search
        if (this.depth === 1 && !isJsonSpace(c) && this.valueOf === this.prop) this.stop();
        else if (this.depth === 0 && !isJsonSpace(c)) this.stop();
    }
  }

  private keep(c: string): void {
    if (this.role === "other") return;
    this.raw += c;
    if (this.role === "value" && this.raw.length > VALUE_MAX_CHARS) this.stop();
    else if (this.role === "key" && this.raw.length > KEY_MAX_CHARS) this.role = "other";
  }

  private closeString(): void {
    this.inString = false;
    const role = this.role;
    this.role = "other";
    if (this.depth !== 1) return;
    if (this.expectKey) {
      this.expectKey = false;
      this.key = role === "key" ? decode(this.raw) : null;
      return;
    }
    if (role === "value") {
      this.result = decode(this.raw);
      this.stop();
      return;
    }
    this.valueOf = null;
  }

  private stop(): void {
    this.done = true;
  }
}

/** JSON whitespace (RFC 8259): space, tab, line feed, carriage return. */
const isJsonSpace = (c: string): boolean => c === " " || c === "\n" || c === "\t" || c === "\r";

/** A JSON string body (between its quotes) decoded; null when it is not valid JSON. */
function decode(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(`"${raw}"`);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The value of a top-level string property once its closing quote arrived; null before. */
export function closedStringProperty(json: string, prop: string): string | null {
  return new TopLevelStringProperty(prop).feed(json);
}

/**
 * The input view that starts a base read for the step's tool `name` (ruling R7): only the builtin
 * `Write`'s; an extension or connector tool declaring `file_write` gets no base, and a tool whose
 * source is unknown gets none either.
 */
export function writeBaseViewOf(
  tools: readonly {
    key: string;
    spec: { inputView?: ToolInputView };
    source?: ResolvedTool["source"];
  }[],
  name: string,
): ToolInputView | undefined {
  const t = tools.find((x) => x.key === name);
  if (t?.source?.kind !== "builtin" || t.source.name !== "Write") return undefined;
  return t.spec.inputView?.kind === "file_write" ? t.spec.inputView : undefined;
}

/** A `Write` base: the file's current text and the sha256 (hex) of its bytes. */
export interface WriteBase {
  text: string;
  sha256: string;
}

/** Reads a `Write` base; null whenever there is none to show (never throws for a missing base). */
export interface WriteBaseReader {
  read(input: {
    conversationId: string;
    path: string;
    signal: AbortSignal;
  }): Promise<WriteBase | null>;
}

/**
 * Watches one model stream attempt's tool calls (streaming tool input spec §4.1): a call whose tool
 * declares `inputView.kind: "file_write"` starts one base read once its path property closed, at
 * most one per call id, without blocking the stream. A read that resolves after `signal` aborted
 * (a step reset, the stream's end, the run's abort) emits nothing; a read that throws is logged
 * and dropped. The attempt aborts `signal` and then awaits {@link settle}, so no admission starts
 * after its step moves on (each read checks the signal right before its admission) and a read
 * still running normally ends with it. The wait is bounded ({@link WRITE_BASE_SETTLE_MS}): a read
 * whose provider ignores the abort is logged once and left to end in the background.
 */
export function writeBaseWatcher(deps: {
  reader: WriteBaseReader;
  inputViewOf(toolName: string): ToolInputView | undefined;
  emit(callId: string, base: WriteBase): void;
  conversationId: string;
  signal: AbortSignal;
  log: Pick<Logger, "warn">;
  /** The bound of {@link settle} in milliseconds (default {@link WRITE_BASE_SETTLE_MS}). */
  settleMs?: number;
}): {
  onStart(callId: string, name: string): void;
  onInput(callId: string, fragment: string): void;
  /**
   * Resolves once every read started so far has finished, or once the settle bound elapsed
   * (logged once; the reads left keep running in the background). Never rejects.
   */
  settle(): Promise<void>;
} {
  const watching = new Map<string, TopLevelStringProperty>();
  /** The reads in flight (each removes itself when it finishes). */
  const inFlight = new Set<Promise<void>>();
  /** Call ids already seen: a repeated start never starts a second read. */
  const seen = new Set<string>();
  let warnedStray = false;

  const read = async (callId: string, path: string): Promise<void> => {
    try {
      const base = await deps.reader.read({
        conversationId: deps.conversationId,
        path,
        signal: deps.signal,
      });
      if (base === null || deps.signal.aborted) return;
      deps.emit(callId, base);
    } catch (err) {
      if (deps.signal.aborted) return;
      deps.log.warn("write base not shown: the read failed", {
        conversationId: deps.conversationId,
        callId,
        err,
      });
    }
  };

  return {
    onStart(callId, name) {
      if (deps.signal.aborted || seen.has(callId)) return;
      seen.add(callId);
      const view = deps.inputViewOf(name);
      if (view?.kind !== "file_write") return;
      watching.set(callId, new TopLevelStringProperty(view.path));
    },
    onInput(callId, fragment) {
      const scanner = watching.get(callId);
      if (scanner === undefined) return;
      if (deps.signal.aborted) {
        watching.delete(callId);
        return;
      }
      const path = scanner.feed(fragment);
      if (path === null) return;
      // one read per call id, whatever follows
      watching.delete(callId);
      const pending = read(callId, path);
      inFlight.add(pending);
      void pending.finally(() => inFlight.delete(pending));
    },
    async settle() {
      if (inFlight.size === 0) return;
      const boundMs = deps.settleMs ?? WRITE_BASE_SETTLE_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // the attempt's own timer, cleared when the wait ends
      const expired = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), boundMs);
      });
      try {
        while (inFlight.size > 0) {
          const all = Promise.allSettled([...inFlight]).then(() => "done" as const);
          if ((await Promise.race([all, expired])) === "done") continue;
          if (!warnedStray) {
            warnedStray = true;
            deps.log.warn("write base read still running after its abort; not waited for", {
              conversationId: deps.conversationId,
              pending: inFlight.size,
              boundMs,
            });
          }
          return;
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
