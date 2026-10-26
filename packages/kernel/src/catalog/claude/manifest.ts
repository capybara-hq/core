import { isSafePackagePath, PLUGIN_MANIFEST_LIMITS } from "@capybara-hq/plugin-sdk";
import { PluginPackageError } from "../plugin-package.js";
import { printable } from "./report.js";

/**
 * Lenient reading of Claude Code's plugin files (`.claude-plugin/plugin.json`, `.mcp.json`,
 * `hooks/hooks.json`; format: spec Appendix A, re-checked against the Claude Code plugins
 * reference on 2026-10-26). Claude's format is open-ended and keeps gaining fields, so there is no
 * schema: every value is type-checked where it is used, and a wrong type is a report item, never
 * an exception (spec §8.1).
 */

/** Claude Code's plugin manifest. */
export const CLAUDE_PLUGIN_FILE = ".claude-plugin/plugin.json";

/**
 * Component fields a marketplace entry may carry (stored in `ClaudeEntryOverlay.components`). The
 * first six are the ones Claude's `strict` rule appends or rejects; the rest apply only to a plugin
 * without its own `plugin.json` (the entry is then the manifest).
 */
export const CLAUDE_STRICT_COMPONENT_KEYS = [
  "skills",
  "commands",
  "agents",
  "hooks",
  "outputStyles",
  "themes",
] as const;
export const CLAUDE_COMPONENT_KEYS = [
  ...CLAUDE_STRICT_COMPONENT_KEYS,
  "mcpServers",
  "lspServers",
  "userConfig",
  "channels",
  "monitors",
  "workflows",
  "experimental",
  "settings",
] as const;

/** A Claude marketplace entry's overlay on the plugin (stored per entry, `marketplace_entries.claude`). */
export interface ClaudeEntryOverlay {
  /** Default true (Claude's rule). */
  strict: boolean;
  /** Component fields of the entry ({@link CLAUDE_COMPONENT_KEYS}), raw JSON. */
  components: Record<string, unknown>;
  /** `author.name` of the entry, else of the marketplace `owner.name`. */
  publisher?: string;
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const decodeUtf8 = (data: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
};

/** A JSON file of the tree: its value, or why it could not be read (English, for the report). */
export type JsonRead = { value: unknown } | { problem: string };

/** Reads a JSON file with the plugin manifest's size cap; never throws. */
export function readJsonFile(data: Uint8Array): JsonRead {
  const max = PLUGIN_MANIFEST_LIMITS.manifestChars;
  if (data.byteLength > max * 4) return { problem: `larger than ${max} characters` };
  const text = decodeUtf8(data);
  if (text === undefined) return { problem: "not valid UTF-8 text" };
  if (text.length > max) return { problem: `larger than ${max} characters` };
  try {
    return { value: JSON.parse(text.startsWith("﻿") ? text.slice(1) : text) };
  } catch {
    return { problem: "not valid JSON" };
  }
}

/** Cuts a string to `max` code points (trimmed). */
export const cut = (s: string, max: number): string => [...s.trim()].slice(0, max).join("");

/** A short, printable rendering of an untrusted key for the report (see {@link printable}). */
export const showName = (s: string): string => cut(printable(s), 200) || "?";

/**
 * Resolves a component path of a Claude manifest (`./x`, or `.` / `./` for the root where
 * `allowRoot`) to a path relative to the plugin root (`""` is the root). A non-string, a path
 * without `./` or the root where it is not allowed is a `{ problem }` (the caller reports it); a
 * path that leaves the root, or is not a safe relative path at all, refuses the import naming it
 * (spec §8.1: paths stay inside the root).
 */
export function componentPath(
  p: unknown,
  where: string,
  allowRoot = false,
): { rel: string } | { problem: string } {
  if (typeof p !== "string") return { problem: "must be a path string" };
  if (allowRoot && (p === "." || p === "./")) return { rel: "" };
  const leaves = p.startsWith("/") || p.split(/[/\\]/).includes("..");
  if (!leaves && !p.startsWith("./")) {
    return { problem: `path ${JSON.stringify(showName(p))} must start with "./"` };
  }
  const rest = p.slice(2).replace(/\/+$/, "");
  if (!leaves && rest === "") {
    return allowRoot
      ? { rel: "" }
      : { problem: `path ${JSON.stringify(showName(p))} must not be the plugin root` };
  }
  if (leaves || !isSafePackagePath(rest)) {
    throw new PluginPackageError("catalog.invalid_manifest", [
      `${where}: path ${JSON.stringify(showName(p))} leaves the plugin root or is not a safe relative path`,
    ]);
  }
  return { rel: rest };
}

/** A string or an array as a list (anything else is `null`). */
export const asList = (v: unknown): unknown[] | null =>
  Array.isArray(v) ? v : v === undefined ? [] : typeof v === "string" || isObj(v) ? [v] : null;
