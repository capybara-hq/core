/**
 * Bounded assembly of a managed background task's retained output (permission runtime cutover
 * phase 8.3, design §B5). Pure: it only calls the {@link OutputReader} it is given, which reads
 * by the task's exact execution ref (`SandboxBackground.readOutput`: no path, no exec, no
 * resume). Every range is read as adjacent bounded requests at the next unassembled offset, so a
 * transport capacity below 4,096 bytes (even one byte) still progresses; a capacity of zero with
 * unread bytes is a deterministic error, never EOF. Memory stays bounded: at most the 4,096-byte
 * parser history plus one fresh window (and the caller's own result budget), never the full
 * retained output.
 */

import { LAST_LINES_MAX_CHARS } from "./session.js";

/** One successful `SandboxBackground.readOutput` answer. */
export interface OutputSlice {
  data: Uint8Array;
  offset: number;
  nextOffset: number;
  totalBytes: number;
}

/** Reads `maxBytes` retained bytes at `offset` by the task's exact ref (no path, no exec). */
export type OutputReader = (
  offset: number,
  maxBytes: number,
) => Promise<OutputSlice | { unavailable: "lost" | "expired" }>;

/**
 * The retained output cannot be read: `lost` (missing or untrustworthy storage, or a snapshot
 * that regressed), `expired` (its retention ended), `mismatch` (the kernel's cursor is past the
 * retained snapshot). The cursor never moves on any of them.
 */
export class ManagedOutputUnavailableError extends Error {
  constructor(
    readonly reason: "lost" | "expired" | "mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ManagedOutputUnavailableError";
  }
}

/** Unread bytes cannot fit the negotiated transport capacity (the reads return nothing). */
export class ManagedOutputCapacityError extends Error {
  constructor() {
    super(
      "The task's output cannot fit the device connection's frame capacity; raise the device and deployment frame limits, reconnect and retry",
    );
    this.name = "ManagedOutputCapacityError";
  }
}

/** The provider's semantic read bound (decoded bytes per read). */
export const MANAGED_READ_MAX_BYTES = 65_536;
/** Already-delivered bytes the login-prompt parser sees again before the new ones. */
export const OUTPUT_HISTORY_BYTES = 4096;
/** The most new bytes one assembly window covers (history plus window fit 65,536 bytes). */
export const FRESH_WINDOW_MAX_BYTES = 61_440;
/** The fewest: any one UTF-8 character fits. */
export const FRESH_WINDOW_MIN_BYTES = 4;
/** The finish and stop summaries keep at most this many lines. */
export const LAST_LINES_MAX_LINES = 20;

const isSlice = (r: OutputSlice | { unavailable: "lost" | "expired" }): r is OutputSlice =>
  !("unavailable" in r);

function unavailable(reason: "lost" | "expired"): ManagedOutputUnavailableError {
  return new ManagedOutputUnavailableError(
    reason,
    reason === "expired"
      ? "The task's retained output has expired"
      : "The task's retained output is no longer available",
  );
}

/**
 * The committed total of the retained output (a zero-budget metadata probe). Throws
 * {@link ManagedOutputUnavailableError} when the record is lost or expired.
 */
export async function probeOutput(read: OutputReader, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const r = await read(0, 0);
  if (!isSlice(r)) throw unavailable(r.unavailable);
  if (r.offset !== 0 || r.nextOffset !== 0 || r.data.length !== 0 || !safeCount(r.totalBytes)) {
    throw new Error("The output metadata probe returned an inconsistent answer");
  }
  return r.totalBytes;
}

const safeCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * Every byte of `[start, end)` of the snapshot whose total was `snapshot` (`end <= snapshot`),
 * read as adjacent requests of at most min(65,536, end - position) bytes each, at the next
 * unassembled offset. A later read may report a larger total (the output grew): its bytes past
 * `end` are never requested. A total below `snapshot` is a lost record, not EOF; a read that
 * returns nothing while bytes remain is a capacity error.
 */
export async function readOutputRange(
  read: OutputReader,
  start: number,
  end: number,
  snapshot: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!(safeCount(start) && safeCount(end) && start <= end && end <= snapshot)) {
    throw new Error(`Invalid output range [${start}, ${end}) of ${snapshot}`);
  }
  const out = new Uint8Array(end - start);
  let pos = start;
  while (pos < end) {
    signal?.throwIfAborted();
    const budget = Math.min(MANAGED_READ_MAX_BYTES, end - pos);
    const r = await read(pos, budget);
    if (!isSlice(r)) throw unavailable(r.unavailable);
    if (
      r.offset !== pos ||
      r.data.length > budget ||
      r.nextOffset !== pos + r.data.length ||
      !safeCount(r.totalBytes)
    ) {
      throw new Error("The output read returned an inconsistent range");
    }
    if (r.totalBytes < snapshot) throw unavailable("lost");
    if (r.data.length === 0) throw new ManagedOutputCapacityError();
    out.set(r.data, pos - start);
    pos += r.data.length;
  }
  return out;
}

/** How many bytes a UTF-8 lead byte starts (1 for anything that is not a multi-byte lead). */
const sequenceLength = (b: number): number =>
  b >= 0xf0 && b <= 0xf7 ? 4 : b >= 0xe0 ? (b <= 0xef ? 3 : 1) : b >= 0xc0 ? 2 : 1;

/**
 * The bytes still missing to complete the character `buf` ends inside, 0 when it ends on a
 * character boundary (or on bytes that can never form one: those decode as replacements).
 */
export function missingUtf8Bytes(buf: Uint8Array): number {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 3 && ((buf[i] as number) & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) return 0;
  const need = sequenceLength(buf[i] as number);
  const have = buf.length - i;
  return need > have ? need - have : 0;
}

/** The length of `buf` without an incomplete trailing character. */
function wholeLength(buf: Uint8Array): number {
  if (missingUtf8Bytes(buf) === 0) return buf.length;
  let i = buf.length - 1;
  while (i >= 0 && ((buf[i] as number) & 0xc0) === 0x80) i--;
  return Math.max(0, i);
}

const decode = (b: Uint8Array): string =>
  Buffer.from(b.buffer, b.byteOffset, b.length).toString("utf8");

/** What one `TaskOutput` assembly delivered. */
export interface TaskOutputAssembly {
  /** The committed total N the probe captured; growth after it is left for the next read. */
  snapshot: number;
  /** The up to 4,096 already-delivered bytes before the cursor (parser history only). */
  history: Uint8Array;
  /** The raw bytes delivered as text now (the cursor advances by exactly their length). */
  delivered: Uint8Array;
  /** `delivered` decoded (replacement characters only for invalid or terminal-incomplete bytes). */
  text: string;
  /** History plus delivered, decoded: what the login-prompt parser reads. */
  parserText: string;
  /** The cursor after this answer: the old cursor plus `delivered.length`. */
  nextOffset: number;
  /** Bytes of the snapshot still unread: max(snapshot - nextOffset, 0). */
  remaining: number;
  /** True when a live incomplete trailing character was left for a later read. */
  withheld: boolean;
}

/**
 * `TaskOutput`'s read (design §B5): probe N; re-read the parser history `[max(0, R - 4096), R)`;
 * then assemble fresh windows of min(max(budget, 4), 61,440) bytes from the cursor R up to N or
 * `budget` bytes, fetching up to three adjacent bytes to complete a character a window cut. On a
 * live stream (or before the snapshot's end) only whole characters are delivered; at a verified
 * terminal end (`terminal`, established before the probe) every remaining byte is delivered with
 * replacement decoding. A cursor past N is unavailable (`mismatch`), never moved back.
 */
export async function assembleTaskOutput(
  read: OutputReader,
  opts: { offset: number; budget: number; terminal: boolean; signal?: AbortSignal },
): Promise<TaskOutputAssembly> {
  const r0 = opts.offset;
  const n = await probeOutput(read, opts.signal);
  if (r0 > n) {
    throw new ManagedOutputUnavailableError(
      "mismatch",
      "The task's read position is past its retained output",
    );
  }
  const history = await readOutputRange(
    read,
    Math.max(0, r0 - OUTPUT_HISTORY_BYTES),
    r0,
    n,
    opts.signal,
  );
  const budget = Math.max(0, Math.floor(opts.budget));
  const chunks: Uint8Array[] = [];
  let pos = r0;
  let withheld = false;
  while (pos < n && pos - r0 < budget) {
    const left = budget - (pos - r0);
    const windowBytes = Math.min(FRESH_WINDOW_MAX_BYTES, Math.max(FRESH_WINDOW_MIN_BYTES, left));
    let end = Math.min(n, pos + windowBytes);
    let raw = await readOutputRange(read, pos, end, n, opts.signal);
    const missing = missingUtf8Bytes(raw);
    if (missing > 0 && end < n) {
      const more = Math.min(n, end + missing);
      raw = concat([raw, await readOutputRange(read, end, more, n, opts.signal)]);
      end = more;
    }
    const finalEnd = opts.terminal && end === n;
    const used = finalEnd ? raw.length : wholeLength(raw);
    if (used > 0) chunks.push(raw.subarray(0, used));
    pos += used;
    if (used < raw.length) {
      withheld = true;
      break;
    }
  }
  const delivered = concat(chunks);
  return {
    snapshot: n,
    history,
    delivered,
    text: decode(delivered),
    parserText: decode(concat([history, delivered])),
    nextOffset: r0 + delivered.length,
    remaining: Math.max(n - (r0 + delivered.length), 0),
    withheld,
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The HTTP output suffix (design §B5): probe N, then every byte of `[max(0, N - tailBytes), N)`
 * through adjacent bounded reads. N stays the end even when later reads report a larger total.
 * A cut suffix drops only its leading partial character; no line limit applies.
 */
export async function assembleOutputSuffix(
  read: OutputReader,
  tailBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean; end: number }> {
  const n = await probeOutput(read, signal);
  const start = Math.max(
    0,
    n - Math.min(MANAGED_READ_MAX_BYTES, Math.max(0, Math.floor(tailBytes))),
  );
  let bytes = await readOutputRange(read, start, n, n, signal);
  const truncated = start > 0;
  if (truncated) {
    let i = 0;
    while (i < bytes.length && i < 3 && ((bytes[i] as number) & 0xc0) === 0x80) i++;
    bytes = bytes.subarray(i);
  }
  return { text: decode(bytes), truncated, end: n };
}

/**
 * A finish or stop summary from a tail: the last 20 lines (a final newline does not count as a
 * line), at most the last 4,000 characters, decoded with replacement characters.
 */
export function lastLinesOf(bytes: Uint8Array): string {
  const text = decode(bytes);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  let out = lines.slice(-LAST_LINES_MAX_LINES).join("\n");
  if (text.endsWith("\n") && out !== "") out += "\n";
  return out.length > LAST_LINES_MAX_CHARS ? out.slice(-LAST_LINES_MAX_CHARS) : out;
}
