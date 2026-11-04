"use client";

import {
  Callout,
  Card,
  Field,
  FormSection,
  Input,
  Repeater,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { Agent, QuickAction } from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import { keys } from "../../lib/query/keys";
import { useUpdateProfile } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { CONFLICT_CODES } from "./BasicsSection";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { useSectionDraft } from "./useSectionDraft";

/** The profile limits (agent profile design §2.1). */
export const QUICK_ACTIONS_MAX = 9;
const TITLE_MAX = 40;
const BODY_MAX = 20_000;

type Entry = QuickAction & { key: string };
type Draft = { items: Entry[] };

const draftOf = (a: Agent): Draft => ({
  items: a.profile.quickActions.map((q, i) => ({ key: `saved-${i}`, ...q })),
});
/** What a draft saves: the entries in order, without their keys. */
const actionsOf = (d: Draft): QuickAction[] => d.items.map(({ title, body }) => ({ title, body }));

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
  const list = agent.profile.quickActions;
  return (
    <AgentSectionFrame>
      <FormSection id="quick-actions" title={t("sections.quick-actions")}>
        {list.length === 0 ? (
          <Text tone="muted">{t("quickActions.none")}</Text>
        ) : (
          <Stack gap={12}>
            {list.map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: titles may repeat; the order is the identity
              <Card key={i} title={q.title}>
                <Text variant="prose">{q.body}</Text>
              </Card>
            ))}
          </Stack>
        )}
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
  const next = useRef(0);
  const update = useUpdateProfile(orgId, agent.id);

  const edit = (fn: (d: Draft) => Draft) => {
    if (!draft.dirty) setBase(agent.profile.updatedAt);
    draft.set(fn);
  };
  const items = draft.draft.items;
  const invalid = (e: Entry) => ({
    title: e.title.trim() === "",
    body: e.body.trim() === "",
  });
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
      actionRow={{
        unsaved,
        errors,
        ...(unsaved > 0 ? { cancel: { label: t("discard"), onSelect: discard } } : {}),
        primary: {
          label: tf("submit"),
          onSelect: () => void save(),
          loading: pending,
          disabled: pending || unsaved === 0,
        },
      }}
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
          <Repeater
            label={t("quickActions.list")}
            addLabel={t("quickActions.add")}
            max={QUICK_ACTIONS_MAX}
            empty={t("quickActions.none")}
            items={items.map((e) => {
              const bad = checked ? invalid(e) : { title: false, body: false };
              return {
                key: e.key,
                title: e.title,
                invalid: bad.title || bad.body,
                body: (
                  <Stack gap={12}>
                    <Field
                      label={t("quickActions.titleLabel")}
                      required
                      count={{ value: e.title.length, max: TITLE_MAX }}
                      {...(bad.title ? { error: t("quickActions.titleRequired") } : {})}
                    >
                      <Input
                        maxLength={TITLE_MAX}
                        value={e.title}
                        onChange={(ev) => {
                          const title = ev.target.value;
                          edit((d) => ({
                            items: d.items.map((x) => (x.key === e.key ? { ...x, title } : x)),
                          }));
                        }}
                      />
                    </Field>
                    <Field
                      label={t("quickActions.bodyLabel")}
                      required
                      help={t("quickActions.bodyHelp")}
                      {...(bad.body ? { error: t("quickActions.bodyRequired") } : {})}
                    >
                      <Textarea
                        rows={4}
                        maxLength={BODY_MAX}
                        value={e.body}
                        onChange={(ev) => {
                          const body = ev.target.value;
                          edit((d) => ({
                            items: d.items.map((x) => (x.key === e.key ? { ...x, body } : x)),
                          }));
                        }}
                      />
                    </Field>
                  </Stack>
                ),
              };
            })}
            onAdd={() => {
              next.current += 1;
              const key = `new-${next.current}`;
              edit((d) =>
                d.items.length >= QUICK_ACTIONS_MAX
                  ? d
                  : { items: [...d.items, { key, title: "", body: "" }] },
              );
            }}
            onRemove={(key) => {
              const before = items;
              edit((d) => ({ items: d.items.filter((x) => x.key !== key) }));
              return () => edit(() => ({ items: before }));
            }}
            onMove={(key, to) =>
              edit((d) => {
                const from = d.items.findIndex((x) => x.key === key);
                if (from < 0) return d;
                const list = [...d.items];
                const [moved] = list.splice(from, 1);
                if (moved) list.splice(to, 0, moved);
                return { items: list };
              })
            }
          />
        </FormSection>
      </Stack>
    </AgentSectionFrame>
  );
}
