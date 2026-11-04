"use client";

import { Checkbox, Field, FormSection, Select, Stack, Text } from "@capybara-hq/design";
import { useQueries } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  type Agent,
  type AgentToolRef,
  BUILTIN_TOOLS,
  type TightenedPolicy,
} from "../../lib/agents";
import type { ConnectorDetail } from "../../lib/connectors";
import { retryOnMountOf } from "../../lib/query/client";
import { connectorQuery } from "../../lib/query/conversation";
import { BUILTIN_SET, replaceToolRefs, sameJson, savedDefinition } from "./definition-parts";
import {
  SaveFeedback,
  useDefinitionSave,
  useSectionActionRow,
  WithFormData,
} from "./definition-save";
import type { AgentFormData } from "./form-data";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { useSectionDraft } from "./useSectionDraft";

/** The references this section switches: the listed builtins and whole connectors. */
const isSectionTool = (r: AgentToolRef) =>
  (r.kind === "builtin" && BUILTIN_SET.has(r.name)) ||
  (r.kind === "connector" && r.tools === "all");

type Draft = {
  builtins: string[];
  connectors: string[];
  policies: Record<string, TightenedPolicy>;
};
const draftOf = (a: Agent): Draft => {
  const tools = a.definition.tools ?? [];
  return {
    builtins: tools.flatMap((r) =>
      r.kind === "builtin" && BUILTIN_SET.has(r.name) ? [r.name] : [],
    ),
    connectors: tools.flatMap((r) =>
      r.kind === "connector" && r.tools === "all" ? [r.connectorId] : [],
    ),
    policies: { ...(a.definition.toolPolicies ?? {}) },
  };
};
const sorted = (xs: string[]) => [...xs].sort();

/**
 * 工具 Tools (agent profile design §3.2): the builtin tools, the active connectors (all their
 * enabled tools) and a tightened policy per referenced tool. Its save sends the saved definition
 * with only `tools` and `toolPolicies` changed: references it does not switch (plugin tools,
 * connectors picked by name, the `agent` tool of Sub-agents) and their policies stay as saved.
 */
export function ToolsSection() {
  return <WithFormData>{(data) => <ToolsEdit data={data} />}</WithFormData>;
}

function ToolsEdit({ data }: { data: AgentFormData }) {
  const t = useTranslations("agents");
  const { orgId, agent } = useAgentPage();
  const save = useDefinitionSave();
  const actionRow = useSectionActionRow();
  const saved = draftOf(agent);
  const draft = useSectionDraft(saved);
  const d = draft.draft;
  // the connectors on offer: the active ones (none when the list could not be read)
  const apps = (data.connectors ?? []).filter((a) => a.status === "active");
  // every connector selected since the section opened: their tools are read (cached), so one
  // switched off again still counts as managed when its policies are dropped on save
  const [seen, setSeen] = useState<string[]>(saved.connectors);
  const seenIds = [...new Set([...seen, ...d.connectors])];
  const details = useQueries({
    queries: seenIds.map((id) => {
      const q = connectorQuery(orgId, id);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  const connectorDetails: Record<string, ConnectorDetail> = Object.fromEntries(
    seenIds.flatMap((id, i) => {
      const x = details[i]?.data;
      return x === undefined ? [] : [[id, x]];
    }),
  );
  const edit = (fn: (cur: Draft) => Draft) => {
    save.begin();
    draft.set(fn);
  };

  /** The referenced tool keys (for tightening): the builtins and the selected connectors' tools. */
  const toolKeys = [
    ...d.builtins,
    ...d.connectors.flatMap((id) =>
      (connectorDetails[id]?.tools ?? []).filter((x) => x.status === "enabled").map((x) => x.key),
    ),
  ];

  const unsaved = [
    !sameJson(sorted(d.builtins), sorted(saved.builtins)),
    !sameJson(sorted(d.connectors), sorted(saved.connectors)),
    !sameJson(d.policies, saved.policies),
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending) return;
    const picked: AgentToolRef[] = [
      ...d.builtins.map((name) => ({ kind: "builtin" as const, name })),
      ...d.connectors.map((connectorId) => ({
        kind: "connector" as const,
        connectorId,
        tools: "all" as const,
      })),
    ];
    // a policy of a tool this section manages goes with it; the others stay as saved
    const managed = (k: string) =>
      BUILTIN_SET.has(k) ||
      Object.values(connectorDetails).some((a) => a.tools.some((x) => x.key === k));
    const r = await save.send({
      ...savedDefinition(agent),
      tools: replaceToolRefs(agent.definition.tools ?? [], isSectionTool, picked),
      toolPolicies: Object.fromEntries(
        Object.entries(d.policies).filter(([k]) => toolKeys.includes(k) || !managed(k)),
      ),
    });
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
          id="tools"
          title={t("form.toolsSection")}
          description={t("form.toolsSectionHint")}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: fieldset 带浏览器默认边框与内边距，apps/web 不能写样式；用 role=group 分组 */}
          <div role="group" aria-label={t("form.builtinLabel")}>
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("form.builtinLabel")}
              </Text>
              {BUILTIN_TOOLS.map((name) => (
                <Checkbox
                  key={name}
                  label={t(`form.builtin.${name}`)}
                  checked={d.builtins.includes(name)}
                  disabled={save.pending}
                  onChange={(on) =>
                    edit((cur) => ({
                      ...cur,
                      builtins: on
                        ? [...cur.builtins, name]
                        : cur.builtins.filter((x) => x !== name),
                    }))
                  }
                />
              ))}
            </Stack>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: fieldset 带浏览器默认边框与内边距，apps/web 不能写样式；用 role=group 分组 */}
          <div role="group" aria-label={t("form.connectorsLabel")}>
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("form.connectorsLabel")}
              </Text>
              {apps.length === 0 && (
                <Text variant="small" tone="faint">
                  {t("form.noConnectors")}
                </Text>
              )}
              {apps.map((a) => (
                <Checkbox
                  key={a.id}
                  label={t("form.connectorTools", { name: a.name })}
                  checked={d.connectors.includes(a.id)}
                  disabled={save.pending}
                  onChange={(on) => {
                    if (on) setSeen((cur) => (cur.includes(a.id) ? cur : [...cur, a.id]));
                    edit((cur) => ({
                      ...cur,
                      connectors: on
                        ? [...cur.connectors, a.id]
                        : cur.connectors.filter((id) => id !== a.id),
                    }));
                  }}
                />
              ))}
            </Stack>
          </div>
          {toolKeys.length > 0 && (
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("form.policiesLabel")}
              </Text>
              {toolKeys.map((key) => (
                <div key={key} data-policy={key}>
                  <Field label={key}>
                    <Select
                      value={d.policies[key] ?? ""}
                      disabled={save.pending}
                      onChange={(e) => {
                        const v = e.target.value as TightenedPolicy | "";
                        edit((cur) => {
                          const policies = { ...cur.policies };
                          if (v === "") delete policies[key];
                          else policies[key] = v;
                          return { ...cur, policies };
                        });
                      }}
                      options={[
                        { value: "", label: t("form.policy.default") },
                        { value: "ask", label: t("form.policy.ask") },
                        { value: "deny", label: t("form.policy.deny") },
                      ]}
                    />
                  </Field>
                </div>
              ))}
            </Stack>
          )}
        </FormSection>
      </Stack>
    </AgentSectionFrame>
  );
}
