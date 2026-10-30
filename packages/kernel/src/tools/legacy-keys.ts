import { BUILTIN, type BuiltinName } from "./builtin-names.js";

/**
 * The release-candidate builtin tool names (tool naming spec §8.1). FROZEN: it describes the names
 * of the 0.1.0 release candidates and never grows. Old keys stay in logs, recordings and stored
 * configuration; this map is how the kernel reads them. `check:terms` exempts this file.
 */
export interface LegacyBuiltin {
  /** The new name. */
  name: BuiltinName;
  /** Old parameter name -> new parameter name (only the renamed ones). */
  params: Readonly<Record<string, string>>;
  /** New parameters whose value is in milliseconds where the old one was in seconds (× 1000). */
  msParams?: readonly string[];
}

export const LEGACY_BUILTINS: Readonly<Record<string, LegacyBuiltin>> = Object.freeze({
  sandbox_bash: {
    name: BUILTIN.Bash,
    params: { timeoutSeconds: "timeout" },
    msParams: ["timeout"],
  },
  sandbox_read: { name: BUILTIN.Read, params: { path: "file_path" } },
  sandbox_write: { name: BUILTIN.Write, params: { path: "file_path" } },
  sandbox_edit: {
    name: BUILTIN.Edit,
    params: {
      path: "file_path",
      oldText: "old_string",
      newText: "new_string",
      replaceAll: "replace_all",
    },
  },
  sandbox_glob: { name: BUILTIN.Glob, params: {} },
  sandbox_grep: { name: BUILTIN.Grep, params: { ignoreCase: "-i" } },
  sandbox_deliver: { name: BUILTIN.Deliver, params: { path: "file_path" } },
  skill_load: { name: BUILTIN.Skill, params: { name: "skill" } },
  skill_write: { name: BUILTIN.SkillWrite, params: {} },
  ask_user: { name: BUILTIN.AskUserQuestion, params: {} },
  read_tool_output: { name: BUILTIN.ReadToolOutput, params: {} },
  tool_search: { name: BUILTIN.ToolSearch, params: { limit: "max_results" } },
  agent: { name: BUILTIN.Agent, params: {} },
} satisfies Record<string, LegacyBuiltin>);

/** Is `key` a release-candidate builtin name? */
export const isLegacyBuiltinKey = (key: string): boolean => Object.hasOwn(LEGACY_BUILTINS, key);

/** What a connector slug / extension name can be, to read an old `<x>__<tool>` key. */
export interface LegacyScope {
  connectorSlugs: ReadonlySet<string>;
  extensionNames: ReadonlySet<string>;
}

/**
 * The current key of a release-candidate key: a builtin by the frozen map; `<x>__<tool>` becomes
 * `mcp__x__tool` when `x` is only a connector slug in `scope`, `plugin__x__tool` when only an
 * extension name, else null (ambiguous, unknown, or not an old key).
 */
export function legacyToolKey(key: string, scope?: LegacyScope): string | null {
  if (isLegacyBuiltinKey(key)) return (LEGACY_BUILTINS[key] as LegacyBuiltin).name;
  if (scope === undefined) return null;
  const i = key.indexOf("__");
  if (i <= 0 || i + 2 >= key.length) return null;
  const head = key.slice(0, i);
  const tool = key.slice(i + 2);
  const connector = scope.connectorSlugs.has(head);
  const extension = scope.extensionNames.has(head);
  if (connector === extension) return null;
  return connector ? `mcp__${head}__${tool}` : `plugin__${head}__${tool}`;
}

/** The input of an old builtin call in the current parameter names (seconds -> milliseconds). */
export function legacyToolInput(oldKey: string, input: unknown): unknown {
  if (!isLegacyBuiltinKey(oldKey)) return input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const { params, msParams } = LEGACY_BUILTINS[oldKey] as LegacyBuiltin;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const next = Object.hasOwn(params, k) ? (params[k] as string) : k;
    out[next] = msParams?.includes(next) === true && typeof v === "number" ? v * 1000 : v;
  }
  return out;
}

/** The new parameters of the builtins whose parameters were renamed (model-visible hint text). */
const HINT_PARAMS: Readonly<Record<string, string>> = {
  Bash: "command, description, timeout in milliseconds",
  Read: "file_path, offset, limit",
  Write: "file_path, content",
  Edit: "file_path, old_string, new_string, replace_all",
  Grep: "pattern, path, glob, -i, output_mode, -n, -A, -B, -C, head_limit, offset",
  Deliver: "file_path, name",
  Skill: "skill, args",
  ToolSearch: "query, max_results",
};

/** The model-visible hint for a call to an old builtin key; null for any other key. */
export function legacyHint(key: string): string | null {
  if (!isLegacyBuiltinKey(key)) return null;
  const { name } = LEGACY_BUILTINS[key] as LegacyBuiltin;
  const params = HINT_PARAMS[name];
  return `Tool "${key}" no longer exists; it is now "${name}"${params === undefined ? "" : ` (parameters: ${params})`}.`;
}
