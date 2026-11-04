import { isLegacyBuiltinKey } from "../../tools/legacy-keys.js";
import type { SkillTexts } from "./skills.js";

/**
 * The system texts of a request as the release candidates rendered them, naming the old builtins
 * (`skill_load`, `tool_search`). FROZEN: verbatim copies from `main` at 02b9634b
 * (`runtime/context/skills.ts`, `tools/builtins/tool-search.ts`); never edit them. A request whose
 * tools hold an old builtin key (a recording made before the rename) is rebuilt with these, so it
 * reconstructs with no `system_hash` drift (tool naming spec §10). `check:terms` exempts this file.
 *
 * The skills texts (`skills.ts`) naming `skill_load`.
 */
export const LEGACY_SKILL_TEXTS: SkillTexts = Object.freeze({
  skillsCatalogHeader:
    "Skills are available in this conversation. A skill is a set of instructions, sometimes with " +
    "scripts or other files, for a specific kind of task. When a task matches a skill's description, " +
    "call skill_load with the skill's name to read its instructions before you start; do not guess " +
    "what a skill says. Available skills:",
  newSkills: "New skills (call skill_load with the name to use one):",
  updatedSkills: "Updated skills (call skill_load again before relying on earlier instructions):",
  currentSkills:
    "Skills available in this conversation now (this replaces any earlier list of skills; call " +
    "skill_load with a name to read a skill's instructions):",
  invokedSkills: (names: readonly string[]) =>
    `Skills the user invoked earlier in this conversation: ${names.join(", ")}. Call skill_load with a name to read its instructions again.`,
  pinnedSkillsHeader:
    "Pinned skills: the owner of this agent pinned these skills, so their instructions apply " +
    "throughout this conversation. Follow them without calling skill_load; call skill_load " +
    "only to copy a pinned skill's files into the sandbox.",
});

/** The tool catalog header (`tools/builtins/tool-search.ts` `CATALOG_HEADER`) naming `tool_search`. */
export const LEGACY_CATALOG_HEADER =
  "More tools are available but not loaded. To use one, first call tool_search with keywords; " +
  "it returns the full definitions and loads the matching tools for your next step. " +
  "Calling a tool that is not loaded returns an error. Tool catalog:";

/**
 * Was this request's tool list recorded before the rename? True when one of its tool keys is a
 * release-candidate builtin name (the run's tools, as the request carries them). Every request
 * that renders one of these texts offers the tool it names (`skill_load` whenever the log has a
 * skills catalog or an invocation, `tool_search` with a tool catalog), so the tools decide it.
 */
export function usesLegacyToolNames(tools: readonly { key: string }[]): boolean {
  return tools.some((t) => isLegacyBuiltinKey(t.key));
}
