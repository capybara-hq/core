"use client";

import { FormSection, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { Agent, AgentDefinitionInput, DisabledSkillRef } from "../../lib/agents";
import { canonicalOff } from "../../lib/skills-off";
import { OrgSkillsPicker, OwnSkills, SkillRegistrationSwitch } from "../AgentSkills";
import { navLevelOf } from "../shell/nav";
import { useSession } from "../shell/session";
import { sameJson, savedDefinition } from "./definition-parts";
import {
  SaveFeedback,
  useDefinitionSave,
  useSectionActionRow,
  WithFormData,
} from "./definition-save";
import type { AgentFormData } from "./form-data";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { useSectionDraft } from "./useSectionDraft";

type Draft = { off: DisabledSkillRef[]; confirmSkillRegister: boolean };
const draftOf = (a: Agent): Draft => ({
  off: [...(a.definition.disabledSkills ?? [])],
  confirmSkillRegister: a.definition.skills?.writePolicy === "ask",
});

/**
 * 技能 Skills (skills default-on spec §10): two titled regions in one card: the skills on in the
 * org, every one on unless the agent turns it off (`disabledSkills`), and the agent's own skills
 * (upload and share for the owner, always on) with the registration confirmation. The
 * confirmation (`skills.writePolicy`, governs `agents.register-skill`) applies only to private
 * agents, so it shows when the **saved** visibility is private (Basics' draft never counts). Its
 * save sends the saved definition with only `disabledSkills` and `skills` changed.
 */
export function SkillsSection() {
  return <WithFormData>{(data) => <SkillsEdit data={data} />}</WithFormData>;
}

function SkillsEdit({ data }: { data: AgentFormData }) {
  const t = useTranslations("agents");
  const { me } = useSession();
  const { orgId, agent } = useAgentPage();
  const save = useDefinitionSave();
  const actionRow = useSectionActionRow();
  const saved = draftOf(agent);
  const draft = useSectionDraft(saved);
  const d = draft.draft;
  const own = data.ownSkills ?? [];
  /** The org skills this agent shared: always on for it, listed with its own. */
  const sharedHere = new Set(own.filter((s) => s.shared === true).map((s) => s.id));
  const isPrivate = agent.visibility === "private";
  const edit = (fn: (cur: Draft) => Draft) => {
    save.begin();
    draft.set(fn);
  };
  const offChanged = !sameJson(canonicalOff(d.off), canonicalOff(saved.off));

  const unsaved = [
    offChanged,
    // the switch shows only on private agents: a hidden change does not count
    isPrivate && d.confirmSkillRegister !== saved.confirmSkillRegister,
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending) return;
    const definition: Omit<AgentDefinitionInput, "instructionFiles"> = savedDefinition(agent);
    if (offChanged) definition.disabledSkills = canonicalOff(d.off);
    // writePolicy: written only when the switch changed; off = the key removed (allow)
    if (d.confirmSkillRegister !== saved.confirmSkillRegister) {
      const { writePolicy: _w, ...rest } = agent.definition.skills ?? {};
      const skills = d.confirmSkillRegister ? { ...rest, writePolicy: "ask" as const } : rest;
      if (Object.keys(skills).length > 0) definition.skills = skills;
      else delete definition.skills;
    }
    const r = await save.send(definition);
    if (r.saved) draft.reset();
  }

  function discard() {
    draft.reset();
    save.clear();
  }

  return (
    <AgentSectionFrame
      dirty={draft.dirty}
      actionRow={actionRow({
        unsaved,
        errors: save.error ? 1 : 0,
        pending: save.pending,
        onDiscard: discard,
        onSave: () => void onSave(),
      })}
    >
      <Stack gap={16}>
        <SaveFeedback save={save} onReload={() => void save.reload(discard)} />
        <FormSection
          id="skills"
          title={t("form.skillsSection")}
          description={t("form.skillsSectionHint")}
        >
          <OrgSkillsPicker
            // a skill this agent shared is always on for it: listed in its own region
            skills={data.orgSkills?.filter((s) => !sharedHere.has(s.id))}
            value={d.off}
            onChange={(off) => edit((cur) => ({ ...cur, off }))}
            extraOn={own.length}
            // members browse the skills page, guests don't (the nav's audience)
            skillsHref={navLevelOf(me) === "guest" ? undefined : "/skills"}
          />
          <OwnSkills
            orgId={orgId}
            agentId={agent.id}
            skills={own}
            canManage={agent.ownerAccountId === me.account.id}
          >
            {isPrivate && (
              <SkillRegistrationSwitch
                value={d.confirmSkillRegister}
                onChange={(confirmSkillRegister) =>
                  edit((cur) => ({ ...cur, confirmSkillRegister }))
                }
              />
            )}
          </OwnSkills>
        </FormSection>
      </Stack>
    </AgentSectionFrame>
  );
}
