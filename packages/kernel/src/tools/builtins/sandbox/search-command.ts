import { shellQuote } from "./common.js";

/**
 * Directories `Grep` and `Glob` never walk into, whatever the ignore files say: version control
 * metadata, installed packages and tool caches (`.cache`: a docker device's HOME is the workspace,
 * so a search of the workspace outside a repository would walk its caches). A path given
 * explicitly is still searched (only directories met while walking are skipped).
 */
export const ALWAYS_SKIPPED_DIRS = [
  ".git",
  ".hg",
  ".svn",
  ".jj",
  "node_modules",
  ".cache",
] as const;

/**
 * Runs `rg` when the device has it, else `fallback`, in one shell command (no extra round trip
 * to find out). Both branches print the same format, so the caller parses either the same way.
 */
const preferRg = (rg: string, fallback: string): string =>
  `if command -v rg >/dev/null 2>&1; then ${rg}; else ${fallback}; fi`;

/**
 * The ripgrep options shared by both tools: no user config file (`RIPGREP_CONFIG_PATH` could
 * change the output format), hidden files included like grep and find (the ignore files and the
 * skipped directories decide what is left out), the always-skipped directories excluded.
 */
const RG_BASE = ["rg", "--no-config", "--hidden"];
const RG_SKIP = ALWAYS_SKIPPED_DIRS.map((d) => `--glob=${shellQuote(`!${d}`)}`);

export type GrepMode = "content" | "files_with_matches" | "count";

export interface GrepCommandOptions {
  mode: GrepMode;
  pattern: string;
  /** What to search, relative to the command's cwd: `.` for a directory, else a file name. */
  target: string;
  /** Whether `target` is a directory (searched recursively) or a single file. */
  directory: boolean;
  /** Content mode: prefix line numbers. */
  numbered: boolean;
  ignoreCase: boolean;
  /** Content mode: `-A` / `-B` / `-C` lines of context. */
  context: { A?: number | undefined; B?: number | undefined; C?: number | undefined };
  glob?: string;
}

/**
 * The shell command `Grep` runs. Every branch prints what `grep -H --null` prints: the file name,
 * NUL, then `<line number>:<line>` (content), `<count>` (count) or nothing (files with matches;
 * the NUL ends the name), and `--` between context groups.
 *
 * A directory is searched with ripgrep when the device has it (it skips what the `.gitignore`,
 * `.ignore` and `.rgignore` files ignore, and binary files), sorted by path so `offset` pages
 * over a stable order; otherwise with `grep -r` skipping {@link ALWAYS_SKIPPED_DIRS}. A single
 * file is always searched with grep: there is nothing to walk, and `grep -I` treats a binary file
 * as not matching where ripgrep would print a "binary file matches" line.
 */
export function grepCommand(o: GrepCommandOptions): string {
  const context =
    o.mode === "content"
      ? (["A", "B", "C"] as const).flatMap((f) =>
          o.context[f] !== undefined ? [`-${f}`, String(o.context[f])] : [],
        )
      : [];
  const ignoreCase = o.ignoreCase ? ["-i"] : [];
  const tail = ["-e", shellQuote(o.pattern), "--", shellQuote(o.target)];
  // --null: a NUL instead of `:` after the file name, so names with newlines or colons parse
  const grepMode =
    o.mode === "files_with_matches"
      ? ["-rlIE", "--null"]
      : o.mode === "count"
        ? ["-rcHIE", "--null"]
        : [o.numbered ? "-rnHIE" : "-rHIE", "--null"];
  const grep = [
    "grep",
    ...grepMode,
    ...ignoreCase,
    ...context,
    ...(o.glob !== undefined ? [`--include=${shellQuote(o.glob)}`] : []),
    // only for a directory: GNU grep also applies the excludes to the names on the command line
    ...(o.directory ? ALWAYS_SKIPPED_DIRS.map((d) => `--exclude-dir=${shellQuote(d)}`) : []),
    ...tail,
  ].join(" ");
  if (!o.directory) return grep;
  const rgMode =
    o.mode === "files_with_matches"
      ? ["-l"]
      : o.mode === "count"
        ? ["-c"]
        : [o.numbered ? "-n" : "-N", "--no-heading"];
  const rg = [
    ...RG_BASE,
    "--color=never",
    "--sort=path",
    "--null",
    "-H",
    ...rgMode,
    ...ignoreCase,
    ...context,
    // the user's glob before the exclusions: a later --glob wins in ripgrep
    ...(o.glob !== undefined ? [`--glob=${shellQuote(o.glob)}`] : []),
    ...RG_SKIP,
    ...tail,
  ].join(" ");
  return preferRg(rg, grep);
}

/**
 * The shell command `Glob` runs in the directory to search: every file below it as `./<path>`,
 * each followed by NUL. With ripgrep when the device has it (skipping what the ignore files
 * ignore), else `find` skipping {@link ALWAYS_SKIPPED_DIRS}. Neither follows symbolic links.
 */
export function listFilesCommand(): string {
  const rg = [...RG_BASE, ...RG_SKIP, "--files", "--null", "--", "."].join(" ");
  const prune = ALWAYS_SKIPPED_DIRS.map((d) => `-name ${shellQuote(d)}`).join(" -o ");
  const find = `find . \\( ${prune} \\) -prune -o -type f -print0`;
  return preferRg(rg, find);
}
