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
