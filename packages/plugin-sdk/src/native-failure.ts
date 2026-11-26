/**
 * The model-facing text of a failed native file operation (#907), one mapping for every native
 * helper and provider (capybara-device, device-docker, device-e2b). A native helper answers
 * `{ error: { code } }` with an errno name (`ENOENT`, …), `SCOPE_DENIED`, `NOT_REGULAR_FILE` or
 * `INVALID_NATIVE_REQUEST`; its own exception text never reaches the model (it may carry paths or
 * other details), only the kernel-defined text for the code.
 */

/** The code a native helper answers when a read or write names something other than a regular file. */
export const NATIVE_NOT_REGULAR_FILE = "NOT_REGULAR_FILE";

/** The text for a code this mapping does not know. */
export const NATIVE_FAILURE_GENERIC =
  "Native operation failed; check the path, scope and filesystem access";

const TEXTS: Readonly<Record<string, string>> = {
  [NATIVE_NOT_REGULAR_FILE]:
    "The path is not a regular file (it is a directory, a device or another special file); only regular files can be read or written",
  ENOENT: "The path, or one of its parent directories, does not exist; check the path",
  ENOTDIR: "A component of the path is not a directory; check the path",
  EISDIR: "The path is a directory, not a file",
  EEXIST: "The path already exists",
  ENAMETOOLONG: "The path is too long",
  ENOSPC: "The device's disk is full; free some space, then retry",
  EDQUOT: "The device's disk quota is exhausted; free some space, then retry",
  EROFS: "The path is on a read-only file system",
  EFBIG: "The file is too large for the device's file system",
  EBUSY: "The file is busy; retry the call",
  ESTALE: "The file changed while it was being used; retry the call",
  EIO: "The device's disk reported an input/output error",
};

/** The model-facing text for a native helper's error code. */
export function nativeFailureText(code: string | undefined): string {
  return (
    (code !== undefined && Object.hasOwn(TEXTS, code) ? TEXTS[code] : undefined) ??
    NATIVE_FAILURE_GENERIC
  );
}
