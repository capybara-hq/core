import type { DisabledSkillRef } from "./agents";
import { type SkillSummary, skillAliases } from "./skills";

/**
 * Which skills an agent (or a template) turns off, as the skills section edits it (skills
 * default-on spec §4, §10). Every skill on in the org is on unless an entry turns it off:
 * a plugin entry names the plugin's skills by name or the whole plugin (`"all"`, its later skills
 * too); a skill entry names a skill without a plugin by key (an agent: the skill's id or a linked
 * copy's; a template: the skill's name). Entries the section does not show (a plugin the org
 * turned off, a deleted skill) are kept as they are.
 */
export type SkillKeyOf = (s: SkillSummary) => string[];

/** An agent's skill entries name a skill by id (or a linked copy's id). */
export const skillIdKeys: SkillKeyOf = skillAliases;

/** A template's skill entries name a skill by its name. */
export const skillNameKeys: SkillKeyOf = (s) => [s.name];

/** Is `s` off? A builtin skill never is. */
export function skillIsOff(
  off: readonly DisabledSkillRef[],
  s: SkillSummary,
  keyOf: SkillKeyOf = skillIdKeys,
): boolean {
  if (s.builtin === true) return false;
  if (s.plugin) {
    const e = pluginEntry(off, s.plugin);
    return e !== undefined && (e.skills === "all" || e.skills.includes(s.name));
  }
  const keys = keyOf(s);
  return off.some((r) => r.kind === "skill" && keys.includes(r.skillId));
}

const pluginEntry = (off: readonly DisabledSkillRef[], plugin: string) =>
  off.find(
    (r): r is Extract<DisabledSkillRef, { kind: "plugin" }> =>
      r.kind === "plugin" && r.plugin === plugin,
  );

/** The plugin is off as a whole (`"all"`). */
export const pluginAllOff = (off: readonly DisabledSkillRef[], plugin: string): boolean =>
  pluginEntry(off, plugin)?.skills === "all";

/**
 * How a plugin group's change is made: `row` (one row: unchecking the last one on collapses the
 * entry to `"all"`), `head` (the group head without a filter: the whole plugin, `"all"` or nothing)
 * or `shown` (the head while a filter is active: only the shown rows by name, never `"all"`).
 */
export type PluginChange = "row" | "head" | "shown";

/**
 * Turns `names` of `plugin` on or off. `known` is every skill name of the plugin the section
 * shows (to collapse to `"all"` and to expand `"all"` when one is turned back on).
 */
export function setPluginSkills(
  off: readonly DisabledSkillRef[],
  plugin: string,
  known: readonly string[],
  names: readonly string[],
  on: boolean,
  how: PluginChange,
): DisabledSkillRef[] {
  const prev = pluginEntry(off, plugin);
  const rest = off.filter((r) => r !== prev);
  const put = (skills: "all" | string[]) => {
    const entry: DisabledSkillRef = { kind: "plugin", plugin, skills };
    return prev === undefined ? [...rest, entry] : off.map((r) => (r === prev ? entry : r));
  };
  if (how === "head") return on ? rest : put("all");
  const wasAll = prev?.skills === "all";
  if (wasAll && !on) return [...off];
  const cur = new Set(wasAll ? known : (prev?.skills ?? []));
  for (const n of names) {
    if (on) cur.delete(n);
    else cur.add(n);
  }
  if (cur.size === 0) return rest;
  if (how === "row" && !on && known.length > 0 && known.every((n) => cur.has(n))) {
    return put("all");
  }
  return put([...cur].sort());
}

/** Turns skills without a plugin on (every entry naming one of their keys goes) or off. */
export function setOwnSkills(
  off: readonly DisabledSkillRef[],
  skills: readonly SkillSummary[],
  on: boolean,
  keyOf: SkillKeyOf = skillIdKeys,
): DisabledSkillRef[] {
  if (on) {
    const drop = new Set(skills.flatMap(keyOf));
    return off.filter((r) => r.kind !== "skill" || !drop.has(r.skillId));
  }
  const add = skills
    .filter((s) => !skillIsOff(off, s, keyOf))
    .flatMap((s) => {
      const key = keyOf(s)[0];
      return key === undefined ? [] : [{ kind: "skill" as const, skillId: key }];
    });
  return [...off, ...add];
}

/**
 * A template's `disallowedSkills` as off entries: `<plugin>:*` the whole plugin, `<plugin>:<name>`
 * a plugin's skill, a bare `<name>` a skill without a plugin (its name as the key).
 */
export function disallowedToOff(disallowed: readonly string[]): DisabledSkillRef[] {
  const out: DisabledSkillRef[] = [];
  for (const ref of disallowed) {
    const i = ref.indexOf(":");
    if (i < 0) {
      out.push({ kind: "skill", skillId: ref });
      continue;
    }
    const plugin = ref.slice(0, i);
    const name = ref.slice(i + 1);
    const prev = pluginEntry(out, plugin);
    if (name === "*") {
      if (prev) prev.skills = "all";
      else out.push({ kind: "plugin", plugin, skills: "all" });
    } else if (prev === undefined) out.push({ kind: "plugin", plugin, skills: [name] });
    else if (prev.skills !== "all" && !prev.skills.includes(name)) prev.skills.push(name);
  }
  return out;
}

/** Off entries as a template's `disallowedSkills` (see {@link disallowedToOff}). */
export function offToDisallowed(off: readonly DisabledSkillRef[]): string[] {
  return off.flatMap((r) =>
    r.kind === "skill"
      ? [r.skillId]
      : r.skills === "all"
        ? [`${r.plugin}:*`]
        : r.skills.map((n) => `${r.plugin}:${n}`),
  );
}

/**
 * `off` in a canonical order (the kernel's `canonicalDisabledSkills`): one entry per plugin, sorted
 * by plugin, `"all"` absorbing names, names deduplicated and sorted, then the skill entries
 * deduplicated and sorted. Two lists that turn off the same skills compare equal.
 */
export function canonicalOff(off: readonly DisabledSkillRef[]): DisabledSkillRef[] {
  const plugins = new Map<string, "all" | Set<string>>();
  const ids = new Set<string>();
  for (const r of off) {
    if (r.kind === "skill") {
      ids.add(r.skillId);
      continue;
    }
    const prev = plugins.get(r.plugin);
    if (prev === "all" || r.skills === "all") plugins.set(r.plugin, "all");
    else plugins.set(r.plugin, new Set([...(prev ?? []), ...r.skills]));
  }
  return [
    ...[...plugins.entries()]
      .filter(([, v]) => v === "all" || v.size > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([plugin, v]): DisabledSkillRef => ({
          kind: "plugin",
          plugin,
          skills: v === "all" ? "all" : [...v].sort(),
        }),
      ),
    ...[...ids].sort().map((skillId): DisabledSkillRef => ({ kind: "skill", skillId })),
  ];
}
