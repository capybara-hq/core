"use client";

import {
  Field,
  FormSection,
  Input,
  KeyValue,
  RadioGroup,
  Stack,
  SwitchField,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { Agent, AgentAttribution, AgentDefinitionInput } from "../../lib/agents";
import { usePageQuery } from "../../lib/query/page-query";
import { orgSettingsQuery } from "../../lib/query/settings";
import { ErrorFrame } from "../ErrorFrame";
import { savedDefinition } from "./definition-parts";
import { SaveFeedback, useDefinitionSave, useSectionActionRow } from "./definition-save";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { useSectionDraft } from "./useSectionDraft";

type Mode = AgentAttribution["mode"];

/** The platform's effective attribution defaults, as the org settings carry them. */
type Platform = { commit: string; pr: string; sessionUrl: boolean };

/** What an agent's runs end a commit and a pull request with. */
type Effective = { commit: string; pr: string; sessionUrl: boolean };

/** The section's draft: the mode and, for `custom`, the values its inputs show. */
interface Draft {
  mode: Mode;
  commit: string;
  pr: string;
  sessionUrl: boolean;
}

/** What a run with this agent's definition ends a commit and a pull request with. */
function effective(a: Agent, platform: Platform): Effective {
  const at = a.definition.attribution;
  if (at?.mode === "off") return { commit: "", pr: "", sessionUrl: false };
  if (at?.mode === "custom") {
    return {
      commit: at.commit ?? platform.commit,
      pr: at.pr ?? platform.pr,
      sessionUrl: at.sessionUrl ?? platform.sessionUrl,
    };
  }
  return platform;
}

const draftOf = (a: Agent, platform: Platform): Draft => {
  const at = a.definition.attribution;
  const done = effective(a, platform);
  return {
    mode: at?.mode ?? "inherit",
    commit: done.commit,
    pr: done.pr,
    sessionUrl: done.sessionUrl,
  };
};

/**
 * The definition a save sends: `inherit` leaves the field out (the agent follows the platform and
 * gains no version for it), `off` and `custom` write it.
 */
function withAttribution(agent: Agent, d: Draft): Omit<AgentDefinitionInput, "instructionFiles"> {
  const { attribution: _current, ...rest } = savedDefinition(agent);
  if (d.mode === "inherit") return rest;
  return {
    ...rest,
    attribution:
      d.mode === "off"
        ? { mode: "off" }
        : { mode: "custom", commit: d.commit, pr: d.pr, sessionUrl: d.sessionUrl },
  };
}

/**
 * 提交与 PR 署名 (spec 2026-11-14-agent-attribution): whether the agent's git commits and pull
 * requests carry the platform's attribution lines (跟随平台, the default), its own (自定义), or
 * none (关闭). It is an instruction to the model, not enforcement. Someone who may use but not
 * change the agent reads the effective values.
 */
export function AttributionSection() {
  const { orgId, editable } = useAgentPage();
  const read = usePageQuery(orgSettingsQuery(orgId));
  if (read.kind === "loading") return <AgentSectionFrame loading />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  const platform: Platform = (read.kind === "ready"
    ? read.data.deployment?.attribution
    : undefined) ?? {
    commit: "Co-Authored-By: Capybara <noreply@capybarahq.com>",
    pr: "🤖 Generated with [Capybara](https://github.com/capybara-hq/core)",
    sessionUrl: false,
  };
  return editable ? (
    <AttributionEdit platform={platform} />
  ) : (
    <AttributionReadOnly platform={platform} />
  );
}

function AttributionEdit({ platform }: { platform: Platform }) {
  const t = useTranslations("agents");
  const { agent } = useAgentPage();
  const save = useDefinitionSave();
  const actionRow = useSectionActionRow();
  const saved = draftOf(agent, platform);
  const draft = useSectionDraft(saved);
  const d = draft.draft;
  const edit = (next: Partial<Draft>) => {
    save.begin();
    draft.set(next);
  };

  async function onSave() {
    if (save.pending) return;
    const r = await save.send(withAttribution(agent, d));
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
        unsaved: draft.dirty ? 1 : 0,
        errors: save.error ? 1 : 0,
        pending: save.pending,
        onDiscard: discard,
        onSave: () => void onSave(),
      })}
    >
      <Stack gap={16}>
        <SaveFeedback save={save} onReload={() => void save.reload(discard)} />
        <FormSection
          id="attribution"
          title={t("form.attributionSection")}
          description={t("form.attributionSectionHint")}
        >
          <Stack gap={12}>
            <RadioGroup
              label={t("form.attributionMode")}
              variant="card"
              value={d.mode}
              onChange={(v) => edit({ mode: v as Mode })}
              options={(["inherit", "custom", "off"] as const).map((m) => ({
                value: m,
                label: t(`form.attributionMode_${m}`),
                description: t(`form.attributionModeHint_${m}`),
              }))}
            />
            {d.mode === "custom" && (
              <Stack gap={12}>
                <Field label={t("form.attributionCommit")} help={t("form.attributionCommitHelp")}>
                  <Input
                    value={d.commit}
                    maxLength={500}
                    onChange={(e) => edit({ commit: e.target.value })}
                  />
                </Field>
                <Field label={t("form.attributionPr")} help={t("form.attributionPrHelp")}>
                  <Input
                    value={d.pr}
                    maxLength={500}
                    onChange={(e) => edit({ pr: e.target.value })}
                  />
                </Field>
                <Stack gap={4}>
                  <SwitchField
                    label={t("form.attributionSessionUrl")}
                    checked={d.sessionUrl}
                    onChange={(next) => edit({ sessionUrl: next })}
                  />
                  <Text variant="small" tone="muted">
                    {t("form.attributionSessionUrlHint")}
                  </Text>
                </Stack>
              </Stack>
            )}
            <Text variant="small" tone="muted">
              {t("form.attributionDefaults", { commit: platform.commit, pr: platform.pr })}
            </Text>
          </Stack>
        </FormSection>
      </Stack>
    </AgentSectionFrame>
  );
}

function AttributionReadOnly({ platform }: { platform: Platform }) {
  const t = useTranslations("agents");
  const { agent } = useAgentPage();
  const at = agent.definition.attribution;
  const mode = at?.mode ?? "inherit";
  const done = effective(agent, platform);
  const off = t("form.attributionNone");
  return (
    <AgentSectionFrame>
      <FormSection id="attribution" title={t("form.attributionSection")}>
        <KeyValue
          rows={[
            { k: t("form.attributionMode"), v: t(`form.attributionMode_${mode}`) },
            { k: t("form.attributionCommit"), v: done.commit === "" ? off : done.commit },
            { k: t("form.attributionPr"), v: done.pr === "" ? off : done.pr },
            {
              k: t("form.attributionSessionUrl"),
              v: done.sessionUrl ? t("form.attributionSessionUrlOn") : off,
            },
          ]}
        />
      </FormSection>
    </AgentSectionFrame>
  );
}
