import { createHash } from "node:crypto";
import { posix } from "node:path";
import { ToolError } from "@capybara-hq/plugin-sdk";
import type { EventLog } from "../../../conversations/event-log.js";

/**
 * Read before `Write` / `Edit` (tool naming spec §4.5). The state of a file as a `Read`, `Write` or
 * `Edit` saw or left it is recorded in the display-only `tool_result.view.file`; before writing,
 * the tools compare the latest recorded state of the path in this conversation's log with the
 * content they read anyway. Nothing lives in process memory, so every replica decides the same.
 */
export interface FileState {
  /** The file's full size in bytes. */
  size: number;
  /** sha256 (hex) of the bytes handled: the first bytes only for a file over `Read`'s byte limit. */
  sha256: string;
}

/** What the tools put into `view.file`: the state plus the full normalized path (never cut). */
export interface RecordedFile extends FileState {
  path: string;
}

export const NOT_READ_TEXT = "File has not been read yet. Read it first before writing to it.";
export const MODIFIED_TEXT =
  "File has been modified since it was read, either by the user or by another command. Read it again before writing to it.";

/** Why the read-before-write check refused a `Write` / `Edit` (`tool_result.view.reason`). */
export type FileGuardReason = "not_read" | "modified";

/**
 * The read-before-write check refused the call: the guard working as designed, not a failed tool.
 * The model sees the message as an error result (as any `ToolError`); the tools turn it into a
 * result with the display-only `guard` view ({@link guardResult}) so the row reads as a neutral
 * outcome.
 */
export class FileGuardError extends ToolError {
  readonly reason: FileGuardReason;

  constructor(reason: FileGuardReason) {
    super(reason === "not_read" ? NOT_READ_TEXT : MODIFIED_TEXT);
    this.reason = reason;
  }
}

/**
 * The result of a call the read-before-write check refused: the same text and `isError` the model
 * got before the marker existed, plus the display-only `guard` view (never in a request).
 */
export function guardResult(e: FileGuardError) {
  return {
    content: [{ type: "text" as const, text: e.message }],
    isError: true,
    view: { kind: "guard" as const, reason: e.reason },
  };
}

/** A `.catch` that returns a {@link FileGuardError} and rethrows everything else. */
export function keepGuardRefusal(e: unknown): FileGuardError {
  if (e instanceof FileGuardError) return e;
  throw e;
}

/** The state of `bytes`, the bytes handled of a file whose full size is `fullSize`. */
export function fileStateOf(bytes: Uint8Array, fullSize: number): FileState {
  return { size: fullSize, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The `view.file` value for a file at `path` (already normalized). */
export function recordedFile(path: string, bytes: Uint8Array, fullSize: number): RecordedFile {
  return { path, ...fileStateOf(bytes, fullSize) };
}

/** POSIX-normalized absolute path (`/workspace/./a.txt` and `/workspace/a.txt` are one file). */
export function normalizeSandboxPath(path: string): string {
  const n = posix.normalize(path);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** The latest recorded state of `path` in the conversation's log; null when it was never recorded. */
export async function lastFileState(
  log: Pick<EventLog, "latestFileState">,
  conversationId: string,
  path: string,
): Promise<FileState | null> {
  return log.latestFileState(conversationId, normalizeSandboxPath(path));
}

/**
 * Throws the model-visible error ({@link FileGuardError}) unless the conversation read (or wrote) the file and it is
 * unchanged: `current` is the state of the content the caller just read.
 */
export async function assertReadAndUnchanged(
  deps: { eventLog: Pick<EventLog, "latestFileState"> },
  conversationId: string,
  path: string,
  current: FileState,
): Promise<void> {
  const seen = await lastFileState(deps.eventLog, conversationId, path);
  if (seen === null) throw new FileGuardError("not_read");
  if (seen.size !== current.size || seen.sha256 !== current.sha256) {
    throw new FileGuardError("modified");
  }
}
