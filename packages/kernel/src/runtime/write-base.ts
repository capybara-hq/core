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

/** What {@link TopLevelStrings} knows of one watched property. */
interface PropState {
  /** The raw (still escaped) text of its string value so far, between its quotes. */
  raw: string;
  /** The event number at which its string value opened (0: not yet). */
  openedAt: number;
  /** The event number at which its string value closed (0: not yet). */
  closedAt: number;
  /** Its decoded value once closed and complete; null before, or when there is none. */
  value: string | null;
  /** No value will come: a non-string value, or a value above its cap in `"drop"` mode. */
  dead: boolean;
  /** The raw text stopped growing at its cap (`"keep-head"` mode): the value stays null. */
  cut: boolean;
}

/** How a watched property's value is capped: dropped past the cap, or only its head kept. */
export interface WatchedProp {
  name: string;
  /** The most raw characters kept (default {@link VALUE_MAX_CHARS}). */
  maxChars?: number;
  /** `drop` (default): a longer value is no value; `keep-head`: the head stays readable. */
  overflow?: "drop" | "keep-head";
}

/**
 * Reads top-level string properties of a JSON object streamed in fragments, without re-reading the
 * buffer: each {@link feed} scans only the new fragment with the carried state. For each watched
 * property it records when its string value opened and closed (one event counter, so the order of
 * two properties is known even within one fragment), its raw head while open ({@link prefix}),
 * and its value once the closing quote arrived (a half path is not a path). A property of a nested
 * object or array, a non-string value, a top level that is not an object, or a value above its cap
 * in `drop` mode gives nothing. The first occurrence of a key counts.
 */
export class TopLevelStrings {
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** At depth 1, the next string is a key. */
  private expectKey = false;
  /** What the string being read is: a key, a watched value, or anything else. */
  private role: { kind: "key" } | { kind: "value"; state: PropState; spec: WatchedProp } | null =
    null;
  /** The raw text of the key being read. */
  private keyRaw = "";
  /** The top-level key read last, until its `:`; null when unknown or too long. */
  private key: string | null = null;
  /** The key whose value comes next at depth 1. */
  private valueOf: string | null = null;
  private events = 0;
  private ended = false;
  private readonly states = new Map<string, { state: PropState; spec: WatchedProp }>();

  constructor(props: readonly WatchedProp[]) {
    for (const spec of props) {
      this.states.set(spec.name, {
        spec,
        state: { raw: "", openedAt: 0, closedAt: 0, value: null, dead: false, cut: false },
      });
    }
  }

  /** Scans `fragment`. */
  feed(fragment: string): void {
    if (this.ended) return;
    for (const c of fragment) {
      this.step(c);
      if (this.ended) break;
    }
  }

  /** The property's value once its string closed; null before (and when there is none). */
  value(prop: string): string | null {
    return this.states.get(prop)?.state.value ?? null;
  }

  /** When the property's string value opened and closed (event numbers; 0: not yet). */
  timing(prop: string): { openedAt: number; closedAt: number } {
    const s = this.states.get(prop)?.state;
    return { openedAt: s?.openedAt ?? 0, closedAt: s?.closedAt ?? 0 };
  }

  /**
   * The decoded head of the property's string value so far (open or closed), an unfinished escape
   * at its end left out; null when its value never opened or is dead.
   */
  prefix(prop: string): string | null {
    const s = this.states.get(prop)?.state;
    if (s === undefined || s.openedAt === 0 || s.dead) return null;
    if (s.value !== null) return s.value;
    return decodeHead(s.raw);
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
      case '"': {
        this.inString = true;
        this.role = null;
        if (this.depth !== 1) return;
        if (this.expectKey) {
          this.role = { kind: "key" };
          this.keyRaw = "";
          return;
        }
        const w = this.valueOf === null ? undefined : this.states.get(this.valueOf);
        if (w !== undefined && w.state.openedAt === 0 && !w.state.dead) {
          w.state.openedAt = ++this.events;
          this.role = { kind: "value", ...w };
        }
        return;
      }
      case "{":
      case "[":
        // the top level must be an object
        if (this.depth === 0 && c === "[") {
          this.ended = true;
          return;
        }
        if (this.depth === 1) this.killValueOf();
        this.depth++;
        if (this.depth === 1) this.expectKey = true;
        return;
      case "}":
      case "]":
        this.depth--;
        if (this.depth <= 0) this.ended = true;
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
        if (isJsonSpace(c)) return;
        // a number or literal: a watched property with it has no string value
        if (this.depth === 1) this.killValueOf();
        else if (this.depth === 0) this.ended = true;
    }
  }

  /** The value about to come at depth 1 is not a string: its property gives nothing. */
  private killValueOf(): void {
    const w = this.valueOf === null ? undefined : this.states.get(this.valueOf);
    if (w !== undefined && w.state.openedAt === 0) w.state.dead = true;
    this.valueOf = null;
  }

  private keep(c: string): void {
    const role = this.role;
    if (role === null) return;
    if (role.kind === "key") {
      this.keyRaw += c;
      if (this.keyRaw.length > KEY_MAX_CHARS) this.role = null;
      return;
    }
    const { state, spec } = role;
    if (state.cut) return;
    if (state.raw.length >= (spec.maxChars ?? VALUE_MAX_CHARS)) {
      if ((spec.overflow ?? "drop") === "drop") {
        state.dead = true;
        state.raw = "";
        this.role = null;
      } else state.cut = true;
      return;
    }
    state.raw += c;
  }

  private closeString(): void {
    this.inString = false;
    const role = this.role;
    this.role = null;
    if (this.depth !== 1) return;
    if (this.expectKey) {
      this.expectKey = false;
      this.key = role?.kind === "key" ? decode(this.keyRaw) : null;
      return;
    }
    const w = this.valueOf === null ? undefined : this.states.get(this.valueOf);
    // a watched value that went dead at its cap still closes (its order stays known)
    if (w !== undefined && w.state.openedAt !== 0 && w.state.closedAt === 0) {
      w.state.closedAt = ++this.events;
      if (role?.kind === "value" && !w.state.cut) w.state.value = decode(w.state.raw);
    }
    this.valueOf = null;
  }
}

/**
 * Reads the value of one top-level string property of a JSON object streamed in fragments
 * ({@link TopLevelStrings} watching that one property).
 */
export class TopLevelStringProperty {
  private readonly scan: TopLevelStrings;

  constructor(private readonly prop: string) {
    this.scan = new TopLevelStrings([{ name: prop }]);
  }

  /** Scans `fragment`; returns the property's value once known, null before (and when none). */
  feed(fragment: string): string | null {
    this.scan.feed(fragment);
    return this.scan.value(this.prop);
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

/**
 * The decoded head of a JSON string body that may stop anywhere: an unfinished escape at its end
 * (a lone backslash, a short `\u` sequence, half of a surrogate pair) is left out.
 */
function decodeHead(raw: string): string | null {
  for (let cut = 0; cut <= 6 && cut <= raw.length; cut++) {
    const v = decode(raw.slice(0, raw.length - cut));
    if (v !== null) return v;
  }
  return null;
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

/** Reads `Write` bases; never throws for a missing base. */
export interface WriteBaseReader {
  /** The base of `path`; null whenever there is none to show. */
  read(input: {
    conversationId: string;
    path: string;
    signal: AbortSignal;
  }): Promise<WriteBase | null>;
  /**
   * The paths of the conversation's newest recorded file states, one per path, newest first, at
   * most `limit` (the candidates of a guessed base).
   */
  recentPaths(input: { conversationId: string; limit: number }): Promise<string[]>;
  /** A model's path as `Write` takes it, normalized; null when it gets no base (synchronous). */
  normalize(rawPath: string): string | null;
}

/** The most candidate files a guessed base reads (spec 2026-11-27 §4.2). */
export const WRITE_BASE_CANDIDATES = 3;
/** The non-blank complete lines of `content` after which the guess is chosen (§4.3). */
export const GUESS_PREFIX_LINES = 8;
/** The least share of the prefix's lines a candidate must contain to be guessed (§4.3). */
export const GUESS_MIN_SCORE = 0.6;
/** The least lead of the guessed candidate over the runner-up (§4.3). */
export const GUESS_MIN_MARGIN = 0.2;
/** The raw characters of `content` the scanner keeps for the guess (only its head matters). */
const CONTENT_HEAD_CHARS = 64 * 1024;

/**
 * The non-blank lines (trimmed) of a streamed text's head: its complete lines, and the last one
 * too once the text is `complete`.
 */
export function guessLines(text: string, complete: boolean): string[] {
  const lines = text.split("\n");
  if (!complete) lines.pop();
  return lines.map((l) => l.trim()).filter((l) => l !== "");
}

/**
 * The candidate a guessed base shows (§4.3), or null: the share of `lines` found among a
 * candidate's lines (trimmed) is its score; the best wins with at least {@link GUESS_MIN_SCORE}
 * and a lead of {@link GUESS_MIN_MARGIN} over the runner-up. No lines: no guess.
 */
export function chooseGuess<T extends { text: string }>(
  lines: readonly string[],
  candidates: readonly T[],
): T | null {
  if (lines.length === 0) return null;
  const scored = candidates
    .map((c) => {
      const have = new Set(c.text.split("\n").map((l) => l.trim()));
      const hits = lines.filter((l) => have.has(l)).length;
      return { c, score: hits / lines.length };
    })
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (best === undefined || best.score < GUESS_MIN_SCORE) return null;
  if (next !== undefined && best.score - next.score < GUESS_MIN_MARGIN) return null;
  return best.c;
}

/**
 * How one streamed `Write` call ended up (the `write input order` log line, spec 2026-11-27 §5):
 * the order of its path and content, and what became of a guess.
 */
type GuessOutcome =
  | "none"
  | "pending"
  | "guessed"
  | "no_candidates"
  | "no_match"
  | "confirmed"
  | "rejected"
  | "path_first_won"
  | "unfinished";

/** One watched `Write` call. */
interface WatchedCall {
  scan: TopLevelStrings;
  view: { path: string; content: string };
  order: "path_first" | "content_first" | "unknown";
  /** The path was handled (an exact read started, or a verdict given): no more guessing. */
  pathDone: boolean;
  guess: GuessOutcome;
  /** The candidates read so far (null: their reads are still running). */
  candidates: { path: string; base: WriteBase }[] | null;
  /** The guess shown, until the path decides on it. */
  guessed: { path: string } | null;
}

/**
 * Watches one model stream attempt's tool calls (streaming tool input spec §4.1, the guess of spec
 * 2026-11-27 §4): a call whose tool declares `inputView.kind: "file_write"` gets its base read once
 * its path property closed, without blocking the stream. When the call's `content` starts before
 * its path closed, the conversation's newest recorded files are read as candidates, and once
 * enough of the content streamed the one it matches clearly goes out as a guessed base; when the
 * path closes, a verdict confirms or withdraws it at once (a withdrawn guess is followed by the
 * exact read of the real path). A read that resolves after `signal` aborted (a step reset, the
 * stream's end, the run's abort) emits nothing; a read that throws is logged and dropped. The
 * attempt aborts `signal` and then awaits {@link settle}, so no admission starts after its step
 * moves on (each read checks the signal right before its admission) and a read still running
 * normally ends with it. The wait is bounded ({@link WRITE_BASE_SETTLE_MS}): a read whose
 * provider ignores the abort is logged once and left to end in the background. {@link settle}
 * also logs one `write input order` line per watched call.
 */
export function writeBaseWatcher(deps: {
  reader: WriteBaseReader;
  inputViewOf(toolName: string): ToolInputView | undefined;
  /** A base: exact, or a guess naming the candidate's path. */
  emit(callId: string, base: WriteBase & { guess?: { path: string } }): void;
  /** The path closed on a guessed base: `confirmed` when it is the guessed file. */
  verdict(callId: string, confirmed: boolean): void;
  conversationId: string;
  /** The model the attempt streams from (only for the log line). */
  model?: { provider: string; model: string };
  signal: AbortSignal;
  log: Pick<Logger, "warn" | "info">;
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
  const calls = new Map<string, WatchedCall>();
  /** The reads in flight (each removes itself when it finishes). */
  const inFlight = new Set<Promise<void>>();
  /** Call ids already seen: a repeated start never starts a second read. */
  const seen = new Set<string>();
  let warnedStray = false;
  let logged = false;

  const track = (p: Promise<void>): void => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  const warnFailed = (callId: string, err: unknown): void => {
    if (deps.signal.aborted) return;
    deps.log.warn("write base not shown: the read failed", {
      conversationId: deps.conversationId,
      callId,
      err,
    });
  };

  const readExact = (callId: string, path: string): void => {
    track(
      (async () => {
        try {
          const base = await deps.reader.read({
            conversationId: deps.conversationId,
            path,
            signal: deps.signal,
          });
          if (base === null || deps.signal.aborted) return;
          deps.emit(callId, base);
        } catch (err) {
          warnFailed(callId, err);
        }
      })(),
    );
  };

  /** Chooses and emits the guess when enough content streamed and the candidates are read. */
  const tryGuess = (callId: string, c: WatchedCall): void => {
    if (c.guess !== "pending" || c.candidates === null || deps.signal.aborted) return;
    const head = c.scan.prefix(c.view.content);
    if (head === null) return;
    const complete = c.scan.timing(c.view.content).closedAt !== 0;
    const lines = guessLines(head, complete);
    if (!complete && lines.length < GUESS_PREFIX_LINES) return;
    if (c.candidates.length === 0) {
      c.guess = "no_candidates";
      return;
    }
    const pick = chooseGuess(
      lines.slice(0, GUESS_PREFIX_LINES),
      c.candidates.map((x) => ({
        ...x,
        text: x.base.text,
      })),
    );
    if (pick === null) {
      c.guess = "no_match";
      return;
    }
    c.guessed = { path: pick.path };
    c.guess = "guessed";
    deps.emit(callId, {
      text: pick.base.text,
      sha256: pick.base.sha256,
      guess: { path: pick.path },
    });
  };

  const readCandidates = (callId: string, c: WatchedCall): void => {
    track(
      (async () => {
        try {
          const paths = await deps.reader.recentPaths({
            conversationId: deps.conversationId,
            limit: WRITE_BASE_CANDIDATES,
          });
          const read = await Promise.all(
            paths.map(async (path) => {
              if (deps.signal.aborted) return null;
              const base = await deps.reader.read({
                conversationId: deps.conversationId,
                path,
                signal: deps.signal,
              });
              return base === null ? null : { path, base };
            }),
          );
          if (deps.signal.aborted) return;
          c.candidates = read.filter((x) => x !== null);
          // the path may have decided while the candidates were read: then no guess
          if (!c.pathDone) tryGuess(callId, c);
        } catch (err) {
          if (c.guess === "pending") c.guess = "no_candidates";
          warnFailed(callId, err);
        }
      })(),
    );
  };

  /** The call's path closed: verdict on a guess, else the exact read as without one. */
  const onPath = (callId: string, c: WatchedCall, rawPath: string): void => {
    c.pathDone = true;
    if (c.guessed !== null) {
      const confirmed = deps.reader.normalize(rawPath) === c.guessed.path;
      c.guess = confirmed ? "confirmed" : "rejected";
      deps.verdict(callId, confirmed);
      if (confirmed) return;
    } else if (c.guess === "pending") c.guess = "path_first_won";
    readExact(callId, rawPath);
  };

  return {
    onStart(callId, name) {
      if (deps.signal.aborted || seen.has(callId)) return;
      seen.add(callId);
      const view = deps.inputViewOf(name);
      if (view?.kind !== "file_write") return;
      calls.set(callId, {
        scan: new TopLevelStrings([
          { name: view.path },
          { name: view.content, maxChars: CONTENT_HEAD_CHARS, overflow: "keep-head" },
        ]),
        view: { path: view.path, content: view.content },
        order: "unknown",
        pathDone: false,
        guess: "none",
        candidates: null,
        guessed: null,
      });
    },
    onInput(callId, fragment) {
      const c = calls.get(callId);
      if (c === undefined || c.pathDone || deps.signal.aborted) return;
      c.scan.feed(fragment);
      const path = c.scan.timing(c.view.path);
      const content = c.scan.timing(c.view.content);
      if (c.order === "unknown") {
        if (content.openedAt !== 0 && (path.closedAt === 0 || content.openedAt < path.closedAt)) {
          c.order = "content_first";
          c.guess = "pending";
          readCandidates(callId, c);
        } else if (path.closedAt !== 0) c.order = "path_first";
      }
      if (path.closedAt !== 0) {
        const raw = c.scan.value(c.view.path);
        // a path too long, or not decodable: no base, as before
        if (raw === null) {
          c.pathDone = true;
          if (c.guessed !== null) {
            c.guess = "rejected";
            deps.verdict(callId, false);
          } else if (c.guess === "pending") c.guess = "path_first_won";
          return;
        }
        onPath(callId, c, raw);
        return;
      }
      tryGuess(callId, c);
    },
    async settle() {
      if (!logged) {
        logged = true;
        for (const c of calls.values()) {
          deps.log.info("write input order", {
            conversationId: deps.conversationId,
            ...(deps.model !== undefined && deps.model),
            order: c.order,
            // a guess the stream ended on before its verdict, or one never chosen
            guess: c.guess === "pending" || c.guess === "guessed" ? "unfinished" : c.guess,
          });
        }
      }
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
