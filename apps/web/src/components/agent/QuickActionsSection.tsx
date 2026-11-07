"use client";

import { Callout, FormSection, Stack } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Agent } from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import { keys } from "../../lib/query/keys";
import { useUpdateProfile } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { CONFLICT_CODES } from "./BasicsSection";
import { AgentSectionFrame, useAgentPage } from "./frame";
import {
  QUICK_ACTIONS_MAX,
  type QuickActionEntry,
  QuickActionsEditor,
  QuickActionsList,
  quickActionEntries,
  quickActionInvalid,
  quickActionsOf,
} from "./QuickActionsEditor";
import { useSectionDraft } from "./useSectionDraft";

type Draft = { items: QuickActionEntry[] };

const draftOf = (a: Agent): Draft => ({ items: quickActionEntries(a.profile.quickActions) });
/** What a draft saves: the entries in order, without their keys. */
const actionsOf = (d: Draft) => quickActionsOf(d.items);

/**
 * 快捷操作 Quick actions (agent profile design §3.2): up to 9 title + body entries; add, edit,
 * delete, reorder; saved through the profile with its `updatedAt`, so a second tab's save is a 409
 * with a reload, never a silent overwrite. Read-only for someone who may not change the agent.
 */
export function QuickActionsSection() {
  const { editable } = useAgentPage();
  return editable ? <QuickActionsEdit /> : <QuickActionsReadOnly />;
}

function QuickActionsReadOnly() {
  const t = useTranslations("agents.page");
  const { agent } = useAgentPage();
  return (
    <AgentSectionFrame>
      {/* The section card is the one box: each action a row (title, then its body), not a card */}
      <FormSection id="quick-actions" title={t("sections.quick-actions")} flush>
        <QuickActionsList list={agent.profile.quickActions} />
      </FormSection>
    </AgentSectionFrame>
  );
}

function QuickActionsEdit() {
  const t = useTranslations("agents.page");
  const tf = useTranslations("agents.form");
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const { orgId, agent } = useAgentPage();
  const saved = draftOf(agent);
  const draft = useSectionDraft(saved);
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const update = useUpdateProfile(orgId, agent.id);

  const edit = (fn: (d: Draft) => Draft) => {
    if (!draft.dirty) setBase(agent.profile.updatedAt);
    draft.set(fn);
  };
  const items = draft.draft.items;
  const invalid = quickActionInvalid;
  const errors = checked
    ? items.filter((e) => invalid(e).title || invalid(e).body).length + (error ? 1 : 0)
    : error
      ? 1
      : 0;
  const savedJson = JSON.stringify(actionsOf(saved));
  const unsaved = draft.dirty && JSON.stringify(actionsOf(draft.draft)) !== savedJson ? 1 : 0;

  async function save() {
    if (pending) return;
    setChecked(true);
    if (items.some((e) => invalid(e).title || invalid(e).body)) return;
    setPending(true);
    setError(null);
    try {
      await update.mutateAsync({
        quickActions: actionsOf(draft.draft),
        expectedUpdatedAt: base ?? agent.profile.updatedAt,
      });
      draft.reset();
      setBase(null);
      setChecked(false);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  function discard() {
    draft.reset();
    setBase(null);
    setError(null);
    setChecked(false);
  }

  async function reload() {
    await qc.refetchQueries({ queryKey: keys.org(orgId).agent(agent.id) });
    discard();
  }

  const conflict = error instanceof ApiClientError && CONFLICT_CODES.has(error.code);
  return (
    <AgentSectionFrame
      dirty={unsaved > 0}
      actionRow={
        unsaved > 0 || pending || errors > 0
          ? {
              unsaved,
              errors,
              ...(unsaved > 0 ? { cancel: { label: t("discard"), onSelect: discard } } : {}),
              primary: {
                label: tf("submit"),
                onSelect: () => void save(),
                loading: pending,
                disabled: pending || unsaved === 0,
              },
            }
          : undefined
      }
    >
      <Stack gap={16}>
        {error ? (
          conflict ? (
            <Callout tone="fail" action={{ label: t("reload"), onSelect: () => void reload() }}>
              {errorMessage(error)}
            </Callout>
          ) : (
            <FormError message={errorMessage(error)} />
          )
        ) : null}
        <FormSection
          id="quick-actions"
          title={t("sections.quick-actions")}
          description={t("quickActions.hint", { max: QUICK_ACTIONS_MAX })}
        >
          <QuickActionsEditor
            items={items}
            edit={(fn) => edit((d) => ({ items: fn(d.items) }))}
            pending={pending}
            checked={checked}
          />
        </FormSection>
      </Stack>
    </AgentSectionFrame>
  );
}
