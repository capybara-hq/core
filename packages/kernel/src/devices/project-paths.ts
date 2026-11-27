import { posix } from "node:path";
import { ApiError } from "../errors.js";
import { clipped } from "./project-rules.js";

/** The longest path relative to a project the kernel takes (the add route's bound). */
export const MAX_PROJECT_RELATIVE_PATH = 4096;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A path relative to a device project (composer menus §5) that is refused: absolute, escaping the
 * project root with `..`, holding a backslash or a control character, or too long. 422
 * `device.path_outside_project` with the path (clipped) in `details`.
 */
export const pathOutsideProject = (rel: string): ApiError =>
  new ApiError(
    "device.path_outside_project",
    "Give a path relative to the project root that stays inside it: no absolute path, no .. above the root, no backslashes or control characters",
    [{ path: clipped(rel) }],
  );

/**
 * `rel` normalized as a posix path relative to a project's root: `""` for the root itself, no
 * `.` segments, no doubled or trailing `/`, `..` resolved. Refused ({@link pathOutsideProject})
 * when it is absolute, climbs above the root, holds a backslash or a control character (NUL
 * included), or is longer than {@link MAX_PROJECT_RELATIVE_PATH}. Pure string work: the device
 * is never asked, so a symlink below the root is the provider's and its browse scope's to judge.
 */
export function projectRelativePath(rel: string): string {
  if (
    rel.length > MAX_PROJECT_RELATIVE_PATH ||
    rel.startsWith("/") ||
    rel.includes("\\") ||
    CONTROL.test(rel)
  ) {
    throw pathOutsideProject(rel);
  }
  if (rel === "") return "";
  const n = posix.normalize(rel);
  if (n === ".." || n.startsWith("../") || posix.isAbsolute(n)) throw pathOutsideProject(rel);
  const trimmed = n.endsWith("/") ? n.slice(0, -1) : n;
  return trimmed === "." ? "" : trimmed;
}

/**
 * The absolute device path of `rel` (normalized through {@link projectRelativePath}, so refused
 * the same way) inside the project rooted at `projectPath`.
 */
export function joinProjectPath(projectPath: string, rel: string): string {
  const r = projectRelativePath(rel);
  const root =
    projectPath.length > 1 && projectPath.endsWith("/") ? projectPath.slice(0, -1) : projectPath;
  if (r === "") return root;
  return root === "/" ? `/${r}` : `${root}/${r}`;
}
