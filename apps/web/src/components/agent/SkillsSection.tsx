"use client";

import { FormSection, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Agent, AgentDefinitionInput } from "../../lib/agents";
import { PINNED_SKILLS_LIMITS, pinnedProblemsOf, type SkillSummary } from "../../lib/skills";
import { OrgSkillsPicker, OwnSkills, PinnedSkillsPicker, SkillWriteSwitch } from "../AgentSkills";
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

type Draft = { orgSkills: string[]; pinned: string[]; confirmSkillWrite: boolean };
const draftOf = (a: Agent): Draft => ({
  orgSkills: [...(a.definition.skills?.orgSkills ?? [])],
  pinned: [...(a.definition.skills?.pinned ?? [])],
  confirmSkillWrite: a.definition.skills?.writePolicy === "ask",
});

/**
 * 技能 Skills (agent profile design §3.2): the org skills, the pinned ones, the `skill_write`
 * confirmation and the agent's own skills. The confirmation (`skills.writePolicy`) applies only
 * to private agents, so it shows when the **saved** visibility is private (Basics' draft never
 * counts). Its save sends the saved definition with only `skills` changed, merged: keys the web
 * does not know stay as saved.
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
  const [pinErrors, setPinErrors] = useState<string[]>([]);
  const orgList = { skills: data.orgSkills ?? [], failed: data.orgSkills === null };
  const own = { skills: data.ownSkills ?? [], failed: data.ownSkills === null };
  const allSkills: SkillSummary[] = [...orgList.skills, ...own.skills];
  /** What the pinned picker may judge (stale pins): both lists read, undefined otherwise. */
  const pinnable = orgList.failed || own.failed ? undefined : allSkills;
  const nameOfSkill = (id: string) => allSkills.find((s) => s.id === id)?.name ?? id;
  const isPrivate = agent.visibility === "private";
  const edit = (fn: (cur: Draft) => Draft) => {
    save.begin();
    draft.set(fn);
  };

  /**
   * Selecting org skills: a newly selected skill its plugin suggests pinning is ticked as pinned
   * while there is room; a deselected one is unpinned.
   */
  function onOrgSkillsChange(next: string[]) {
    edit((cur) => {
      const added = next.filter((id) => !cur.orgSkills.includes(id));
      const removed = cur.orgSkills.filter((id) => !next.includes(id));
      const pinned = cur.pinned.filter((id) => !removed.includes(id));
      for (const id of added) {
        const s = orgList.skills.find((x) => x.id === id);
        if (
          s?.suggestPinned === true &&
          !pinned.includes(id) &&
          pinned.length < PINNED_SKILLS_LIMITS.count
        )
          pinned.push(id);
      }
      return { ...cur, orgSkills: next, pinned };
    });
  }

  const unsaved = [
    !sameJson(d.orgSkills, saved.orgSkills),
    !sameJson(d.pinned, saved.pinned),
    // the switch shows only on private agents: a hidden change does not count
    isPrivate && d.confirmSkillWrite !== saved.confirmSkillWrite,
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending) return;
    const definition: Omit<AgentDefinitionInput, "instructionFiles"> = savedDefinition(agent);
    const before = agent.definition.skills;
    // a definition without skills stays without (no new version); one that had them is saved as
    // it is now (emptied too), merged so unknown keys stay
    if (d.orgSkills.length > 0 || d.confirmSkillWrite || d.pinned.length > 0 || before) {
      const skills = { ...(before ?? {}), orgSkills: d.orgSkills };
      // pinned has no default: written only when something is pinned or it was set before
      if (d.pinned.length > 0 || before?.pinned !== undefined) skills.pinned = d.pinned;
      // writePolicy: written only when the switch changed; off = the key removed (allow)
      if (d.confirmSkillWrite !== saved.confirmSkillWrite) {
        if (d.confirmSkillWrite) skills.writePolicy = "ask";
        else delete skills.writePolicy;
      }
      definition.skills = skills;
    }
    setPinErrors([]);
    const r = await save.send(definition);
    if (r.saved) {
      draft.reset();
      return;
    }
    setPinErrors(
      pinnedProblemsOf(r.error).map((p) =>
        t(`form.pinnedError.${p.reason}`, {
          name: nameOfSkill(p.skill),
          max:
            p.reason === "too_large" ? PINNED_SKILLS_LIMITS.totalBytes : PINNED_SKILLS_LIMITS.count,
          bytes: p.totalBytes ?? 0,
        }),
      ),
    );
  }

  function discard() {
    draft.reset();
    save.clear();
    setPinErrors([]);
  }

  return (
    <AgentSectionFrame
      dirty={draft.dirty}
      actionRow={actionRow({
        unsaved,
        errors: pinErrors.length + (save.error ? 1 : 0),
        pending: save.pending,
        onDiscard: discard,
        onSave: () => void onSave(),
      })}
    >
      <Stack gap={16}>
        <SaveFeedback save={save} onReload={() => void save.reload(discard)} extra={pinErrors} />
        <FormSection
          id="skills"
          title={t("form.skillsSection")}
          description={t("form.skillsSectionHint")}
        >
          <OrgSkillsPicker
            skills={orgList.skills}
            value={d.orgSkills}
            onChange={onOrgSkillsChange}
          />
          <PinnedSkillsPicker
            skills={pinnable}
            selected={[...d.orgSkills, ...own.skills.map((s) => s.id)]}
            value={d.pinned}
            onChange={(pinned) => edit((cur) => ({ ...cur, pinned }))}
            changed={!sameJson(d.pinned, saved.pinned)}
          />
          {isPrivate && (
            <SkillWriteSwitch
              value={d.confirmSkillWrite}
              onChange={(confirmSkillWrite) => edit((cur) => ({ ...cur, confirmSkillWrite }))}
            />
          )}
          <OwnSkills
            orgId={orgId}
            agentId={agent.id}
            skills={own.skills}
            canDelete={agent.ownerAccountId === me.account.id}
            onDeleted={(id) => {
              if (d.pinned.includes(id)) {
                edit((cur) => ({ ...cur, pinned: cur.pinned.filter((x) => x !== id) }));
              }
            }}
          />
        </FormSection>
      </Stack>
    </AgentSectionFrame>
  );
}
