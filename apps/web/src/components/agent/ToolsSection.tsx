"use client";

import { Checkbox, Field, FormSection, Select, Stack, Text } from "@capybara-hq/design";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  type Agent,
  type AgentToolRef,
  BUILTIN_TOOLS,
  type TightenedPolicy,
  WEB_TOOL_POINTS,
} from "../../lib/agents";
import type { ConnectorDetail } from "../../lib/connectors";
import type { ExtensionToolOffer, ExtensionToolsOffer } from "../../lib/extensions";
import { availableExtensionPointsQuery, extensionToolsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { connectorQuery } from "../../lib/query/conversation";
import { extensionToolKey, parseToolKey } from "../../lib/tool-key";
import { toolLabel, toolLabelText } from "../../lib/tool-label";
import { BUILTIN_SET, replaceToolRefs, sameJson, savedDefinition } from "./definition-parts";
import {
  SaveFeedback,
  useDefinitionSave,
  useSectionActionRow,
  WithFormData,
} from "./definition-save";
import type { AgentFormData } from "./form-data";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { PendingConnectorsNotice } from "./PendingConnectorsNotice";
import { useSectionDraft } from "./useSectionDraft";

/** The references this section switches: the listed builtins, extension tools, whole connectors. */
const isSectionTool = (r: AgentToolRef) =>
  (r.kind === "builtin" && BUILTIN_SET.has(r.name)) ||
  r.kind === "plugin" ||
  (r.kind === "connector" && r.tools === "all");

type ExtensionRef = { plugin: string; name: string };
type Draft = {
  builtins: string[];
  /** The selected extension tools (`{kind:"plugin"}` references), in saved order. */
  extensionTools: ExtensionRef[];
  connectors: string[];
  policies: Record<string, TightenedPolicy>;
};
const refKeyOf = (r: ExtensionRef) => extensionToolKey(r.plugin, r.name);
const draftOf = (a: Agent): Draft => {
  const tools = a.definition.tools ?? [];
  return {
    builtins: tools.flatMap((r) =>
      r.kind === "builtin" && BUILTIN_SET.has(r.name) ? [r.name] : [],
    ),
    extensionTools: tools.flatMap((r) =>
      r.kind === "plugin" ? [{ plugin: r.plugin, name: r.name }] : [],
    ),
    connectors: tools.flatMap((r) =>
      r.kind === "connector" && r.tools === "all" ? [r.connectorId] : [],
    ),
    policies: { ...(a.definition.toolPolicies ?? {}) },
  };
};
const sorted = (xs: string[]) => [...xs].sort();

/**
 * 工具 Tools (agent profile design §3.2): the builtin tools, the tools of the extensions enabled in
 * the org (`GET …/tools/extensions`, one `{kind:"plugin"}` reference each), the active connectors
 * (all their enabled tools) and a tightened policy per referenced tool. Its save sends the saved
 * definition with only `tools` and `toolPolicies` changed: references it does not switch
 * (connectors picked by name, the `Agent` tool of Sub-agents) and their policies stay as saved.
 * A selected extension tool the org cannot serve now (extension off or uninstalled) stays listed
 * and ticked as unavailable, with the reason; unticking it is the only way to drop it.
 * A web tool (`WebSearch` / `WebFetch`) is listed only while its point has a provider for the org
 * (`GET …/extension-points/available`) or when the agent selected it, with a hint when a selected
 * one cannot be served now (web tools spec §3.4). Connectors a template needed and the org lacked
 * come first, as the 待配置 notice (ruling P4-7).
 */
export function ToolsSection() {
  return <WithFormData>{(data) => <ToolsEdit data={data} />}</WithFormData>;
}

function ToolsEdit({ data }: { data: AgentFormData }) {
  const t = useTranslations("agents");
  const locale = useLocale();
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
  // which web tools the org can serve now (unreadable: none is offered, saved ones stay listed)
  const pointsQ = availableExtensionPointsQuery(orgId);
  const points = useQuery({ ...pointsQ, retryOnMount: retryOnMountOf(pointsQ.queryKey) });
  const availablePoints: ReadonlySet<string> | undefined =
    points.data !== undefined
      ? new Set(points.data.points.filter((p) => p.available).map((p) => p.point))
      : points.isError
        ? new Set()
        : undefined;
  /** The builtins listed: a web tool only while its point has a provider, or once selected. */
  const listedBuiltins = BUILTIN_TOOLS.filter((name) => {
    const point = WEB_TOOL_POINTS[name];
    return (
      point === undefined ||
      saved.builtins.includes(name) ||
      d.builtins.includes(name) ||
      availablePoints?.has(point) === true
    );
  });
  /** A selected web tool the org cannot serve now. */
  const webUnavailable = d.builtins.some((name) => {
    const point = WEB_TOOL_POINTS[name];
    return point !== undefined && availablePoints !== undefined && !availablePoints.has(point);
  });
  // the tools of the extensions enabled in the org (unreadable: only the selected ones are listed)
  const extQ = extensionToolsQuery(orgId);
  const extQuery = useQuery({ ...extQ, retryOnMount: retryOnMountOf(extQ.queryKey) });
  const offers: ExtensionToolsOffer[] | undefined = extQuery.data?.extensions;
  const offered = new Map<string, { ext: ExtensionToolsOffer; tool: ExtensionToolOffer }>(
    (offers ?? []).flatMap((ext) =>
      ext.tools.map((tool) => [extensionToolKey(ext.plugin, tool.name), { ext, tool }] as const),
    ),
  );
  const lang = locale.startsWith("zh") ? "zh" : "en";
  /** Why a selected extension tool cannot be used now; null while the offer is unknown. */
  const unavailableReason = (r: ExtensionRef): string | null => {
    if (offers === undefined || offered.has(refKeyOf(r))) return null;
    return offers.some((e) => e.plugin === r.plugin)
      ? t("form.extensionToolGone", { extension: r.plugin })
      : t("form.extensionNotEnabled", { extension: r.plugin });
  };
  /** The selected extension tools not on offer now, grouped under their extension's name. */
  const missing = [...saved.extensionTools, ...d.extensionTools]
    .filter((r, i, all) => all.findIndex((x) => refKeyOf(x) === refKeyOf(r)) === i)
    .filter((r) => !offered.has(refKeyOf(r)));
  const extensionGroups: {
    plugin: string;
    name: string;
    tools: { ref: ExtensionRef; label: string; description: string | null }[];
  }[] = [
    ...(offers ?? []).map((ext) => ({
      plugin: ext.plugin,
      name: ext.displayName[lang],
      tools: ext.tools.map((tool) => ({
        ref: { plugin: ext.plugin, name: tool.name },
        label: tool.title ?? tool.name,
        description: tool.description === "" ? null : tool.description,
      })),
    })),
  ];
  for (const r of missing) {
    let g = extensionGroups.find((x) => x.plugin === r.plugin);
    if (!g) {
      g = { plugin: r.plugin, name: r.plugin, tools: [] };
      extensionGroups.push(g);
    }
    g.tools.push({ ref: r, label: r.name, description: null });
  }
  const extensionSelected = (r: ExtensionRef) =>
    d.extensionTools.some((x) => refKeyOf(x) === refKeyOf(r));

  const edit = (fn: (cur: Draft) => Draft) => {
    save.begin();
    draft.set(fn);
  };

  /**
   * The referenced tool keys (for tightening): the builtins, the selected extension tools and the
   * selected connectors' tools.
   */
  const toolKeys = [
    ...d.builtins,
    ...d.extensionTools.map(refKeyOf),
    ...d.connectors.flatMap((id) =>
      (connectorDetails[id]?.tools ?? []).filter((x) => x.status === "enabled").map((x) => x.key),
    ),
  ];

  /** How the policy rows name a tool: builtins by name, connector tools as "<connector> [<tool>]". */
  const policyLabel = (key: string): string => {
    const ext = d.extensionTools.find((r) => refKeyOf(r) === key);
    if (ext) {
      const o = offered.get(key);
      return toolLabelText(
        toolLabel(
          {
            key,
            title: o?.tool.title ?? null,
            tool: ext.name,
            source: {
              kind: "extension",
              name: ext.plugin,
              displayName: o?.ext.displayName ?? { zh: ext.plugin, en: ext.plugin },
            },
          },
          locale,
        ),
      );
    }
    for (const id of d.connectors) {
      const c = connectorDetails[id];
      const x = c?.tools.find((x) => x.key === key);
      if (c && x)
        return toolLabelText(
          toolLabel(
            { key, title: null, tool: x.name, source: { kind: "connector", id, name: c.name } },
            locale,
          ),
        );
    }
    return toolLabelText(toolLabel({ key, title: null, source: { kind: "builtin" } }, locale));
  };

  const unsaved = [
    !sameJson(sorted(d.builtins), sorted(saved.builtins)),
    !sameJson(sorted(d.extensionTools.map(refKeyOf)), sorted(saved.extensionTools.map(refKeyOf))),
    !sameJson(sorted(d.connectors), sorted(saved.connectors)),
    !sameJson(d.policies, saved.policies),
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending) return;
    const picked: AgentToolRef[] = [
      ...d.builtins.map((name) => ({ kind: "builtin" as const, name })),
      ...d.extensionTools.map((r) => ({ kind: "plugin" as const, plugin: r.plugin, name: r.name })),
      ...d.connectors.map((connectorId) => ({
        kind: "connector" as const,
        connectorId,
        tools: "all" as const,
      })),
    ];
    // a policy of a tool this section manages goes with it; the others stay as saved
    const managed = (k: string) =>
      BUILTIN_SET.has(k) ||
      parseToolKey(k)?.kind === "extension" ||
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
        <PendingConnectorsNotice orgId={orgId} agent={agent} />
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
              {listedBuiltins.map((name) => (
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
              {webUnavailable && (
                <Text variant="small" tone="muted">
                  {t("form.webUnavailable")}
                </Text>
              )}
            </Stack>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset brings the browser's border and padding, and apps/web writes no styles: role=group groups it */}
          <div role="group" aria-label={t("form.extensionToolsLabel")}>
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("form.extensionToolsLabel")}
              </Text>
              {extensionGroups.length === 0 && offers !== undefined && (
                <Text variant="small" tone="faint">
                  {t("form.noExtensionTools")}
                </Text>
              )}
              {extQuery.isError && (
                <Text variant="small" tone="faint">
                  {t("form.extensionToolsUnreadable")}
                </Text>
              )}
              {extensionGroups.map((g) => (
                // biome-ignore lint/a11y/useSemanticElements: as above, role=group instead of a fieldset
                <div key={g.plugin} role="group" aria-label={g.name} data-extension={g.plugin}>
                  <Stack gap={4}>
                    <Text variant="small">{g.name}</Text>
                    {g.tools.map(({ ref, label, description }) => {
                      const why = extensionSelected(ref) ? unavailableReason(ref) : null;
                      return (
                        <Stack key={ref.name} gap={0}>
                          <Checkbox
                            label={label}
                            checked={extensionSelected(ref)}
                            disabled={save.pending}
                            onChange={(on) =>
                              edit((cur) => ({
                                ...cur,
                                extensionTools: on
                                  ? [...cur.extensionTools, ref]
                                  : cur.extensionTools.filter((x) => refKeyOf(x) !== refKeyOf(ref)),
                              }))
                            }
                          />
                          {description !== null && (
                            <Text variant="small" tone="faint">
                              {description}
                            </Text>
                          )}
                          {why !== null && (
                            <Text variant="small" tone="warn">
                              {t("form.extensionToolUnavailable", { reason: why })}
                            </Text>
                          )}
                        </Stack>
                      );
                    })}
                  </Stack>
                </div>
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
                  <Field label={policyLabel(key)}>
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
