import type { DisabledSkillRef } from "../../src/agents/definition.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { usableSkills } from "../../src/skills/usable.js";

/**
 * A `disabledSkills` list that leaves an agent only `keep` (skill ids) of the org's usable skills
 * (skills default-on spec §4): every other org skill is turned off, by plugin and name when it has
 * a plugin, else by id. Platform skills are left as they are. For tests written when an agent
 * selected its skills one by one, so their catalogs stay what they were.
 */
export async function onlySkills(
  db: KernelSchemaDb,
  orgId: string,
  keep: readonly string[] = [],
): Promise<DisabledSkillRef[]> {
  const out: DisabledSkillRef[] = [];
  for (const s of await usableSkills(db, orgId)) {
    if (s.origin === "platform" || keep.includes(s.id)) continue;
    if (s.plugin !== null) {
      const prev = out.find(
        (r): r is Extract<DisabledSkillRef, { kind: "plugin" }> =>
          r.kind === "plugin" && r.plugin === s.plugin,
      );
      if (prev && prev.skills !== "all") prev.skills.push(s.name);
      else out.push({ kind: "plugin", plugin: s.plugin, skills: [s.name] });
    } else {
      out.push({ kind: "skill", skillId: s.id });
    }
  }
  return out;
}
