import {
  type Agent,
  type AgentDefinitionInput,
  BUILTIN_TOOLS,
  type DisabledToolRef,
} from "../../lib/agents";
import type { ModelRef } from "../../lib/conversations";

/** The builtin tools the Tools section switches. */
export const BUILTIN_SET = new Set<string>(BUILTIN_TOOLS);

/**
 * The saved definition a section's save starts from: every field as saved, without the prompt
 * files, the retired `avatarUrl` and the pending connectors. The kernel keeps the prompt files
 * while `instructions` is their join (it is, as saved), the profile owns avatars, and a save
 * without `pendingConnectors` keeps the current ones (ruling P4-T3-11: only a template create adds
 * them, only a bind resolves them; a stale copy sent back could only be refused).
 */
export function savedDefinition(agent: Agent): Omit<AgentDefinitionInput, "instructionFiles"> {
  const {
    instructionFiles: _files,
    avatarUrl: _avatarUrl,
    pendingConnectors: _pending,
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

/** A turned-off entry's identity (one entry per builtin, extension and connector). */
const entryKey = (r: DisabledToolRef) =>
  r.kind === "builtin"
    ? `builtin:${r.name}`
    : r.kind === "connector"
      ? `connector:${r.connectorId}`
      : `plugin:${r.plugin}`;

/**
 * The saved turned-off entries with the ones a section manages (`managed`) replaced by `next`:
 * the saved order is kept for entries that stay (with their new tool list), new ones go last, and
 * everything the section does not manage stays as it is. An unchanged pick gives back the saved
 * list exactly, so it makes no new version.
 */
export function replaceDisabled(
  saved: readonly DisabledToolRef[],
  managed: (r: DisabledToolRef) => boolean,
  next: readonly DisabledToolRef[],
): DisabledToolRef[] {
  const byKey = new Map(next.map((r) => [entryKey(r), r] as const));
  const kept = saved.flatMap((r) => {
    if (!managed(r)) return [r];
    const n = byKey.get(entryKey(r));
    return n === undefined ? [] : [sameJson(n, r) ? r : n];
  });
  const keptKeys = new Set(kept.map(entryKey));
  return [...kept, ...next.filter((r) => !keptKeys.has(entryKey(r)))];
}

/** Is builtin `name` turned off in `disabled`? */
export const builtinOff = (disabled: readonly DisabledToolRef[] | undefined, name: string) =>
  (disabled ?? []).some((r) => r.kind === "builtin" && r.name === name);

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
