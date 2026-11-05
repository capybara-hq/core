import {
  type Agent,
  type AgentDefinitionInput,
  type AgentToolRef,
  BUILTIN_TOOLS,
} from "../../lib/agents";
import type { ModelRef } from "../../lib/conversations";

/** The builtin tools the Tools section switches. */
export const BUILTIN_SET = new Set<string>(BUILTIN_TOOLS);

/**
 * The saved definition a section's save starts from: every field as saved, without the prompt
 * files and the retired `avatarUrl`. The kernel keeps the prompt files while `instructions` is
 * their join (it is, as saved), and the profile owns avatars.
 */
export function savedDefinition(agent: Agent): Omit<AgentDefinitionInput, "instructionFiles"> {
  const {
    instructionFiles: _files,
    avatarUrl: _avatarUrl,
    ...kept
  }: Record<string, unknown> = agent.definition;
  return kept as unknown as Omit<AgentDefinitionInput, "instructionFiles">;
}

/** A model select's value: `provider/model` (provider names have no `/`; model ids may). */
export const encodeModel = (r: ModelRef) => `${r.provider}/${r.model}`;
export function decodeModel(v: string): ModelRef | null {
  const i = v.indexOf("/");
  return i <= 0 ? null : { provider: v.slice(0, i), model: v.slice(i + 1) };
}

/** A tool reference's identity, whatever its key order. */
const refKey = (r: AgentToolRef) =>
  r.kind === "builtin"
    ? `builtin:${r.name}`
    : r.kind === "connector"
      ? `app:${r.connectorId}:${r.tools === "all" ? "*" : r.tools.join(",")}`
      : `plugin:${r.plugin}:${r.name}`;

/**
 * The saved tool references with the ones a section manages (`managed`) replaced by `picked`:
 * the saved order is kept for those still picked, new ones go last, and everything the section
 * does not manage stays as it is. An unchanged pick gives back the saved list exactly, so it makes
 * no new version.
 */
export function replaceToolRefs(
  saved: readonly AgentToolRef[],
  managed: (r: AgentToolRef) => boolean,
  picked: readonly AgentToolRef[],
): AgentToolRef[] {
  const pickedKeys = new Set(picked.map(refKey));
  const kept = saved.filter((r) => !managed(r) || pickedKeys.has(refKey(r)));
  const keptKeys = new Set(kept.map(refKey));
  return [...kept, ...picked.filter((r) => !keptKeys.has(refKey(r)))];
}

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
