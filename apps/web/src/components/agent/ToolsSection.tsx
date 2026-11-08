"use client";

import {
  Button,
  EmptyState,
  FormSection,
  ItemList,
  type ItemListRow,
  Sheet,
  Stack,
  Subsection,
  Text,
  ToolPolicyList,
  type ToolPolicyRow,
} from "@capybara-hq/design";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  type Agent,
  type AgentToolPolicy,
  BUILTIN_TOOLS,
  type DisabledToolRef,
  WEB_TOOL_POINTS,
} from "../../lib/agents";
import type { ConnectorDetail } from "../../lib/connectors";
import type { ExtensionToolsOffer } from "../../lib/extensions";
import { availableExtensionPointsQuery, extensionToolsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { connectorQuery } from "../../lib/query/conversation";
import { connectorToolKey, extensionToolKey } from "../../lib/tool-key";
import { BUILTIN_SET, replaceDisabled, sameJson, savedDefinition } from "./definition-parts";
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

/** A group's turned-off tools: all of it (as a unit, tools it gains later included), or names. */
type GroupOff = "all" | string[];
type Draft = {
  /** The listed builtins turned off. */
  builtins: string[];
  /** The extensions with tools turned off, by extension name. */
  extensions: Record<string, GroupOff>;
  /** The connectors with tools turned off, by connector id. */
  connectors: Record<string, GroupOff>;
  policies: Record<string, AgentToolPolicy>;
};
const draftOf = (a: Agent): Draft => {
  const off = a.definition.disabledTools ?? [];
  const extensions: Record<string, GroupOff> = {};
  const connectors: Record<string, GroupOff> = {};
  const merge = (cur: GroupOff | undefined, add: GroupOff): GroupOff =>
    cur === "all" || add === "all" ? "all" : [...new Set([...(cur ?? []), ...add])];
  for (const r of off) {
    if (r.kind === "plugin") extensions[r.plugin] = merge(extensions[r.plugin], r.tools);
    if (r.kind === "connector") {
      connectors[r.connectorId] = merge(connectors[r.connectorId], r.tools);
    }
  }
  return {
    builtins: off.flatMap((r) => (r.kind === "builtin" && BUILTIN_SET.has(r.name) ? [r.name] : [])),
    extensions,
    connectors,
    policies: { ...(a.definition.toolPolicies ?? {}) },
  };
};
const sorted = (xs: string[]) => [...xs].sort();
/** A group map in a comparable form (ids and names sorted). */
const offForm = (c: Record<string, GroupOff>) =>
  Object.keys(c)
    .sort()
    .map((id) => [id, c[id] === "all" ? "all" : sorted(c[id] as string[])]);
/** Is tool `name` turned off by a group's entry? */
const isOff = (g: GroupOff | undefined, name: string) =>
  g !== undefined && (g === "all" || g.includes(name));

/** One tool of a group (an extension's or a connector's), as its row draws it. */
type GroupTool = {
  /** The tool key (the `toolPolicies` key). */
  key: string;
  /** The tool's name in its extension or connector. */
  name: string;
  label: string;
  checked: boolean;
  /** Why a checked tool cannot be used now (the org turned it off). */
  note: string | null;
};
type Group = {
  id: string;
  kind: "extension" | "connector";
  name: string;
  /** What the agent turned off of it (absent: all on). */
  off: GroupOff | undefined;
  /** The key prefix of its tools (`plugin__<p>__` / `mcp__<slug>__`), for its policies. */
  prefix: string;
  /** The rows; null while a connector's tools are being read (or could not be read). */
  tools: GroupTool[] | null;
  readError: boolean;
  onCheck(names: string[], on: boolean): void;
};

/**
 * 工具 Tools (agent profile design §3.2; tools default-on spec §9): an agent has every tool the org
 * offers unless it turns it off, so every checkbox means on / off and starts checked; unchecking
 * writes the tool to `disabledTools`. Every tool sits on one row with its policy next to it
 * (`ToolPolicyList`, design spec §6.36): the builtins in the card, each extension enabled in the
 * org (`GET …/tools/extensions`) and each active connector as one row with a summary (全部开启 /
 * 已关闭 N 个 / 已关闭全部) and 配置, which opens a Sheet with that group's tools. Unchecking every
 * tool of a group turns it off as a unit (`tools: "all"`, its tools now and later). The Sheet edits
 * the section's draft; the section's action row saves it, sending the saved definition with only
 * `disabledTools` and `toolPolicies` changed. Entries it does not switch (the `Agent` tool of
 * Sub-agents, an extension or connector not offered now) and their policies stay as saved. A tool
 * the org turned off stays listed with the reason. A web tool (`WebSearch` / `WebFetch`) is
 * listed only while its point has a provider for the org (`GET …/extension-points/available`) or
 * when the agent turned it off (web tools spec §3.4). Connectors a template needed and the org
 * lacked come first, as the 待配置 notice (ruling P4-7).
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
  const [open, setOpen] = useState<string | null>(null);
  // the connectors on offer: the active ones (none when the list could not be read)
  const apps = (data.connectors ?? []).filter((a) => a.status === "active");
  // the connectors whose tools are read (cached): those with tools turned off and every one opened
  // since the section opened
  const [seen, setSeen] = useState<string[]>(Object.keys(saved.connectors));
  const seenIds = [...new Set([...seen, ...Object.keys(d.connectors)])];
  const details = useQueries({
    queries: seenIds.map((id) => {
      const q = connectorQuery(orgId, id);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  const connectorDetails: Record<string, ConnectorDetail> = {};
  const detailFailed = new Set<string>();
  seenIds.forEach((id, i) => {
    const x = details[i];
    if (x?.data !== undefined) connectorDetails[id] = x.data;
    else if (x?.isError) detailFailed.add(id);
  });
  // which web tools the org can serve now (unreadable: none is offered, turned-off ones stay)
  const pointsQ = availableExtensionPointsQuery(orgId);
  const points = useQuery({ ...pointsQ, retryOnMount: retryOnMountOf(pointsQ.queryKey) });
  const availablePoints: ReadonlySet<string> | undefined =
    points.data !== undefined
      ? new Set(points.data.points.filter((p) => p.available).map((p) => p.point))
      : points.isError
        ? new Set()
        : undefined;
  /** The builtins listed: a web tool only while its point has a provider, or once turned off. */
  const listedBuiltins = BUILTIN_TOOLS.filter((name) => {
    const point = WEB_TOOL_POINTS[name];
    return (
      point === undefined ||
      saved.builtins.includes(name) ||
      d.builtins.includes(name) ||
      availablePoints?.has(point) === true
    );
  });
  // the tools of the extensions enabled in the org (unreadable: their entries stay as saved)
  const extQ = extensionToolsQuery(orgId);
  const extQuery = useQuery({ ...extQ, retryOnMount: retryOnMountOf(extQ.queryKey) });
  const offers: ExtensionToolsOffer[] | undefined = extQuery.data?.extensions;
  const lang = locale.startsWith("zh") ? "zh" : "en";

  const edit = (fn: (cur: Draft) => Draft) => {
    save.begin();
    draft.set(fn);
  };

  /**
   * A group's entry after ticking / unticking `names` of its `listed` tool names: names it lists
   * but this section does not (pending, gone) stay off; every listed tool off is the whole group.
   */
  const nextOff = (
    cur: GroupOff | undefined,
    listed: string[],
    names: string[],
    on: boolean,
  ): GroupOff | undefined => {
    const now = cur === "all" ? listed : (cur ?? []);
    const next = on ? now.filter((n) => !names.includes(n)) : [...new Set([...now, ...names])];
    if (listed.length > 0 && listed.every((n) => next.includes(n))) return "all";
    return next.length === 0 ? undefined : next;
  };
  const setGroup = (
    field: "extensions" | "connectors",
    id: string,
    listed: string[],
    names: string[],
    on: boolean,
  ) =>
    edit((cur) => {
      const map = { ...cur[field] };
      const next = nextOff(map[id], listed, names, on);
      if (next === undefined) delete map[id];
      else map[id] = next;
      return { ...cur, [field]: map };
    });

  /** The extension groups: the extensions enabled in the org. */
  const extensionGroups: Group[] = (offers ?? []).map((ext) => {
    const off = d.extensions[ext.plugin];
    const listed = ext.tools.map((x) => x.name);
    return {
      id: `ext:${ext.plugin}`,
      kind: "extension",
      name: ext.displayName[lang],
      off,
      prefix: extensionToolKey(ext.plugin, ""),
      readError: false,
      tools: ext.tools.map((tool) => {
        const checked = !isOff(off, tool.name);
        return {
          key: extensionToolKey(ext.plugin, tool.name),
          name: tool.name,
          // the declared title; an untitled tool alone in its extension goes by the extension
          label: tool.title ?? (ext.tools.length === 1 ? ext.displayName[lang] : tool.name),
          checked,
          // the org turned it off: no agent gets it, whatever this agent says
          note: checked && tool.switchedOff === true ? t("form.extensionToolOffInOrg") : null,
        };
      }),
      onCheck: (names, on) => setGroup("extensions", ext.plugin, listed, names, on),
    };
  });

  const connectorGroups: Group[] = apps.map((a) => {
    const c = connectorDetails[a.id];
    const off = d.connectors[a.id];
    const enabled = c ? c.tools.filter((x) => x.status === "enabled") : [];
    const listed = enabled.map((x) => x.name);
    return {
      id: `app:${a.id}`,
      kind: "connector",
      name: a.name,
      off,
      prefix: connectorToolKey(a.slug, ""),
      tools: c
        ? enabled.map((x) => ({
            key: x.key,
            name: x.name,
            label: x.title ?? x.name,
            checked: !isOff(off, x.name),
            note: null,
          }))
        : null,
      readError: detailFailed.has(a.id),
      onCheck: (names, on) => setGroup("connectors", a.id, listed, names, on),
    };
  });
  const groups = [...extensionGroups, ...connectorGroups];
  const openGroup = groups.find((g) => g.id === open) ?? null;

  const setPolicy = (key: string, v: string) =>
    edit((cur) => {
      const policies = { ...cur.policies };
      if (v === "") delete policies[key];
      else policies[key] = v as AgentToolPolicy;
      return { ...cur, policies };
    });
  const defaultOption = { value: "", label: t("form.policy.default") };
  const tighten = [
    { value: "ask", label: t("form.policy.ask") },
    { value: "deny", label: t("form.policy.deny") },
  ];
  const policyOptions = [defaultOption, ...tighten];
  // A connector's tools may also be allowed for this agent (decision 2026-11-09): over the org
  // default and a member's own 询问, never over a member's own 禁止
  const connectorPolicyOptions = [
    defaultOption,
    { value: "allow", label: t("form.policy.allow") },
    ...tighten,
  ];
  /** A row's policy: the tightened one of an on tool, else the default. */
  const policyOf = (key: string, checked: boolean) => (checked ? (d.policies[key] ?? "") : "");
  const rowsOf = (tools: GroupTool[]): ToolPolicyRow[] =>
    tools.map((x) => ({
      id: x.key,
      label: x.label,
      checked: x.checked,
      policy: policyOf(x.key, x.checked),
      ...(x.note !== null ? { note: { text: x.note, tone: "warn" as const } } : {}),
    }));

  /** A group row's summary: 全部开启 / 已关闭 N 个 / 已关闭全部 · k 个需审批 · j 个禁止. */
  const summaryOf = (g: Group): string => {
    if (g.off === "all") return t("form.groupAllOff");
    const off = g.off ?? [];
    const onPolicies = Object.entries(d.policies).filter(
      ([k]) => k.startsWith(g.prefix) && !off.includes(k.slice(g.prefix.length)),
    );
    const asks = onPolicies.filter(([, p]) => p === "ask").length;
    const denies = onPolicies.filter(([, p]) => p === "deny").length;
    return [
      off.length === 0 ? t("form.groupAllOn") : t("form.groupOff", { count: off.length }),
      ...(asks > 0 ? [t("form.groupAsk", { count: asks })] : []),
      ...(denies > 0 ? [t("form.groupDeny", { count: denies })] : []),
    ].join(" · ");
  };
  const openSheet = (g: Group) => {
    if (g.kind === "connector") {
      const id = g.id.slice(4);
      setSeen((cur) => (cur.includes(id) ? cur : [...cur, id]));
    }
    setOpen(g.id);
  };
  const groupRows: ItemListRow[] = groups.map((g) => ({
    id: g.id,
    tag: { label: t(`form.groupKind.${g.kind}`) },
    title: g.name,
    meta: summaryOf(g),
    actions: (
      <Button
        density="dense"
        aria-label={t("form.configureGroup", { name: g.name })}
        onClick={() => openSheet(g)}
      >
        {t("form.configure")}
      </Button>
    ),
  }));

  const unsaved = [
    !sameJson(sorted(d.builtins), sorted(saved.builtins)),
    !sameJson(offForm(d.extensions), offForm(saved.extensions)),
    !sameJson(offForm(d.connectors), offForm(saved.connectors)),
    !sameJson(d.policies, saved.policies),
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending) return;
    const offered = new Set((offers ?? []).map((e) => e.plugin));
    const active = new Set(apps.map((a) => a.id));
    // the entries this section switches: the listed builtins, the offered extensions, the active
    // connectors; anything else stays as saved
    const managed = (r: DisabledToolRef) =>
      r.kind === "builtin"
        ? BUILTIN_SET.has(r.name)
        : r.kind === "plugin"
          ? offered.has(r.plugin)
          : active.has(r.connectorId);
    const next: DisabledToolRef[] = [
      ...d.builtins.map((name) => ({ kind: "builtin" as const, name })),
      ...Object.entries(d.extensions)
        .filter(([plugin]) => offered.has(plugin))
        .map(([plugin, tools]) => ({ kind: "plugin" as const, plugin, tools })),
      ...Object.entries(d.connectors)
        .filter(([id]) => active.has(id))
        .map(([connectorId, tools]) => ({ kind: "connector" as const, connectorId, tools })),
    ];
    const r = await save.send({
      ...savedDefinition(agent),
      disabledTools: replaceDisabled(agent.definition.disabledTools ?? [], managed, next),
      // a policy stays with its tool, on or off (it applies again once the tool is back on)
      toolPolicies: d.policies,
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
          <Subsection variant="divided" title={t("form.builtinLabel")}>
            <ToolPolicyList
              label={t("form.builtinLabel")}
              policyOptions={policyOptions}
              disabled={save.pending}
              rows={listedBuiltins.map((name) => {
                const checked = !d.builtins.includes(name);
                return {
                  id: name,
                  label: t(`form.builtin.${name}`),
                  checked,
                  policy: policyOf(name, checked),
                };
              })}
              onCheck={(name, on) =>
                edit((cur) => ({
                  ...cur,
                  builtins: on
                    ? cur.builtins.filter((x) => x !== name)
                    : [...new Set([...cur.builtins, name])],
                }))
              }
              onPolicy={setPolicy}
            />
          </Subsection>
          <Subsection variant="divided" title={t("form.groupsLabel")}>
            {extQuery.isError && (
              <Text variant="prose" tone="muted">
                {t("form.extensionToolsUnreadable")}
              </Text>
            )}
            <ItemList label={t("form.groupsLabel")} rows={groupRows} empty={t("form.noGroups")} />
          </Subsection>
        </FormSection>
        {openGroup !== null && (
          <Sheet
            open
            onOpenChange={(o) => {
              if (!o) setOpen(null);
            }}
            title={openGroup.name}
            meta={t(`form.groupKind.${openGroup.kind}`)}
            footer={
              <Button variant="primary" onClick={() => setOpen(null)}>
                {t("form.sheetDone")}
              </Button>
            }
          >
            <Stack gap={12}>
              <Text variant="prose" tone="muted">
                {t("form.sheetHint")}
              </Text>
              {openGroup.kind === "connector" && (
                <Text variant="prose" tone="muted">
                  {t("form.connectorPolicyHint")}
                </Text>
              )}
              {openGroup.tools === null ? (
                openGroup.readError ? (
                  <Text variant="prose" tone="muted">
                    {t("form.connectorToolsUnreadable")}
                  </Text>
                ) : (
                  <Text variant="prose" tone="muted">
                    {t("form.loadingTools")}
                  </Text>
                )
              ) : openGroup.tools.length === 0 ? (
                <EmptyState size="panel" text={t("form.groupNoTools")} />
              ) : (
                <ToolPolicyList
                  label={t("form.sheetTools", { name: openGroup.name })}
                  policyOptions={
                    openGroup.kind === "connector" ? connectorPolicyOptions : policyOptions
                  }
                  disabled={save.pending}
                  rows={rowsOf(openGroup.tools)}
                  onCheck={(key, on) => openGroup.onCheck(namesOf(openGroup, [key]), on)}
                  onCheckAll={(keys, on) => openGroup.onCheck(namesOf(openGroup, keys), on)}
                  onPolicy={setPolicy}
                  search={openGroup.tools.length > 8}
                />
              )}
            </Stack>
          </Sheet>
        )}
      </Stack>
    </AgentSectionFrame>
  );
}

/** The tool names of a group's rows by key. */
const namesOf = (g: Group, keys: string[]): string[] =>
  (g.tools ?? []).filter((x) => keys.includes(x.key)).map((x) => x.name);
