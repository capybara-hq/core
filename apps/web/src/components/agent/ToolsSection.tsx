"use client";

import {
  Button,
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
  type AgentToolRef,
  BUILTIN_TOOLS,
  type TightenedPolicy,
  WEB_TOOL_POINTS,
} from "../../lib/agents";
import type { ConnectorDetail } from "../../lib/connectors";
import type { ExtensionToolsOffer } from "../../lib/extensions";
import { availableExtensionPointsQuery, extensionToolsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { connectorQuery } from "../../lib/query/conversation";
import { connectorToolKey, extensionToolKey, parseToolKey } from "../../lib/tool-key";
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

/** The references this section switches: the listed builtins, extension tools, connectors. */
const isSectionTool = (r: AgentToolRef) =>
  (r.kind === "builtin" && BUILTIN_SET.has(r.name)) ||
  r.kind === "plugin" ||
  r.kind === "connector";

type ExtensionRef = { plugin: string; name: string };
/** A connector's pick: all its enabled tools (now and later), or the named ones. */
type ConnectorPick = "all" | string[];
type Draft = {
  builtins: string[];
  /** The selected extension tools (`{kind:"plugin"}` references), in saved order. */
  extensionTools: ExtensionRef[];
  /** The used connectors by id, in saved order. */
  connectors: Record<string, ConnectorPick>;
  policies: Record<string, TightenedPolicy>;
};
const refKeyOf = (r: ExtensionRef) => extensionToolKey(r.plugin, r.name);
const draftOf = (a: Agent): Draft => {
  const tools = a.definition.tools ?? [];
  const connectors: Record<string, ConnectorPick> = {};
  for (const r of tools) {
    if (r.kind !== "connector") continue;
    const cur = connectors[r.connectorId];
    connectors[r.connectorId] =
      r.tools === "all" || cur === "all" ? "all" : [...new Set([...(cur ?? []), ...r.tools])];
  }
  return {
    builtins: tools.flatMap((r) =>
      r.kind === "builtin" && BUILTIN_SET.has(r.name) ? [r.name] : [],
    ),
    extensionTools: tools.flatMap((r) =>
      r.kind === "plugin" ? [{ plugin: r.plugin, name: r.name }] : [],
    ),
    connectors,
    policies: { ...(a.definition.toolPolicies ?? {}) },
  };
};
const sorted = (xs: string[]) => [...xs].sort();
/** A connector pick map in a comparable form (ids and names sorted). */
const pickForm = (c: Record<string, ConnectorPick>) =>
  Object.keys(c)
    .sort()
    .map((id) => [id, c[id] === "all" ? "all" : sorted(c[id] as string[])]);

/** One tool of a group (an extension's or a connector's), as its row draws it. */
type GroupTool = {
  /** The tool key (the `toolPolicies` key). */
  key: string;
  label: string;
  checked: boolean;
  /** Why a checked tool cannot be used now. */
  unavailable: string | null;
};
type Group = {
  id: string;
  kind: "extension" | "connector";
  name: string;
  /** The rows; null while a connector's tools are being read (or could not be read). */
  tools: GroupTool[] | null;
  readError: boolean;
  onCheck(keys: string[], on: boolean): void;
};

/**
 * 工具 Tools (agent profile design §3.2): every tool sits on one row with its policy next to it
 * (`ToolPolicyList`, design spec §6.36): the builtins in the card, each extension enabled in the
 * org (`GET …/tools/extensions`, one `{kind:"plugin"}` reference per tool) and each active
 * connector as one row with a summary and 配置, which opens a Sheet with that group's tools. The
 * Sheet edits the section's draft; the section's action row saves it. Its save sends the saved
 * definition with only `tools` and `toolPolicies` changed. A connector is taken whole
 * (`tools: "all"`, its enabled tools now and later) when every enabled tool is ticked, else by
 * tool name; references it does not switch (the `Agent` tool of Sub-agents) and their policies
 * stay as saved. A selected extension tool the org cannot serve now (extension off or
 * uninstalled, or the tool switched off in the org) stays listed and ticked as unavailable, with
 * the reason; unticking it is the only
 * way to drop it. A web tool (`WebSearch` / `WebFetch`) is listed only while its point has a
 * provider for the org (`GET …/extension-points/available`) or when the agent selected it, with a
 * hint when a selected one cannot be served now (web tools spec §3.4). Connectors a template
 * needed and the org lacked come first, as the 待配置 notice (ruling P4-7).
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
  // the connectors whose tools are read (cached): the used ones and every one opened since the
  // section opened, so one switched off again still counts as managed when its policies drop
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
  const offered = new Set(
    (offers ?? []).flatMap((ext) =>
      ext.tools.map((tool) => extensionToolKey(ext.plugin, tool.name)),
    ),
  );
  const lang = locale.startsWith("zh") ? "zh" : "en";

  const edit = (fn: (cur: Draft) => Draft) => {
    save.begin();
    draft.set(fn);
  };

  /** Why a selected extension tool cannot be used now; null while the offer is unknown. */
  const unavailableReason = (r: ExtensionRef): string | null => {
    if (offers === undefined || offered.has(refKeyOf(r))) return null;
    const reason = offers.some((e) => e.plugin === r.plugin)
      ? t("form.extensionToolGone", { extension: r.plugin })
      : t("form.extensionNotEnabled", { extension: r.plugin });
    return t("form.extensionToolUnavailable", { reason });
  };
  const extensionSelected = (key: string) => d.extensionTools.some((x) => refKeyOf(x) === key);
  /** Ticks or unticks extension tools (by key) of one extension. */
  const checkExtension = (plugin: string, keys: string[], on: boolean) =>
    edit((cur) => {
      const rest = cur.extensionTools.filter((x) => !keys.includes(refKeyOf(x)));
      if (!on) return { ...cur, extensionTools: rest };
      const added = keys.flatMap((k) => {
        const p = parseToolKey(k);
        return p?.kind === "extension" ? [{ plugin, name: p.tool }] : [];
      });
      // keep the saved order of those already ticked
      const kept = cur.extensionTools.filter((x) => keys.includes(refKeyOf(x)));
      return {
        ...cur,
        extensionTools: [
          ...rest,
          ...kept,
          ...added.filter((a) => !kept.some((k) => refKeyOf(k) === refKeyOf(a))),
        ],
      };
    });

  /** The extension groups: the offered extensions, then selected tools no longer offered. */
  const extensionGroups: Group[] = (offers ?? []).map((ext) => ({
    id: `ext:${ext.plugin}`,
    kind: "extension",
    name: ext.displayName[lang],
    readError: false,
    tools: ext.tools.map((tool) => {
      const key = extensionToolKey(ext.plugin, tool.name);
      const checked = extensionSelected(key);
      return {
        key,
        // the declared title; an untitled tool alone in its extension goes by the extension
        label: tool.title ?? (ext.tools.length === 1 ? ext.displayName[lang] : tool.name),
        checked,
        // a selected tool the org turned off stays ticked, marked like any unavailable one
        unavailable: checked && tool.switchedOff === true ? t("form.extensionToolOffInOrg") : null,
      };
    }),
    onCheck: (keys, on) => checkExtension(ext.plugin, keys, on),
  }));
  const missing = [...saved.extensionTools, ...d.extensionTools]
    .filter((r, i, all) => all.findIndex((x) => refKeyOf(x) === refKeyOf(r)) === i)
    .filter((r) => !offered.has(refKeyOf(r)));
  for (const r of missing) {
    let g = extensionGroups.find((x) => x.id === `ext:${r.plugin}`);
    if (!g) {
      g = {
        id: `ext:${r.plugin}`,
        kind: "extension",
        name: r.plugin,
        readError: false,
        tools: [],
        onCheck: (keys, on) => checkExtension(r.plugin, keys, on),
      };
      extensionGroups.push(g);
    }
    const key = refKeyOf(r);
    const checked = extensionSelected(key);
    g.tools?.push({
      key,
      label: r.name,
      checked,
      unavailable: checked ? unavailableReason(r) : null,
    });
  }

  /** The enabled tool names of a connector (null while its tools are unknown). */
  const enabledNames = (id: string): string[] | null => {
    const c = connectorDetails[id];
    return c ? c.tools.filter((x) => x.status === "enabled").map((x) => x.name) : null;
  };
  /** The names a connector pick ticks now. */
  const pickedNames = (id: string): string[] => {
    const p = d.connectors[id];
    if (p === undefined) return [];
    return p === "all" ? (enabledNames(id) ?? []) : p;
  };
  /** Ticks or unticks connector tools by name: every enabled tool ticked takes it whole. */
  const checkConnector = (id: string, names: string[], on: boolean) => {
    const all = enabledNames(id) ?? [];
    edit((cur) => {
      const p = cur.connectors[id];
      const now = p === undefined ? [] : p === "all" ? all : p;
      const next = on
        ? [...now, ...names.filter((n) => !now.includes(n))]
        : now.filter((n) => !names.includes(n));
      const connectors = { ...cur.connectors };
      if (next.length === 0) delete connectors[id];
      else connectors[id] = all.length > 0 && all.every((n) => next.includes(n)) ? "all" : next;
      return { ...cur, connectors };
    });
  };
  const connectorGroups: Group[] = apps.map((a) => {
    const c = connectorDetails[a.id];
    const picked = pickedNames(a.id);
    let tools: GroupTool[] | null = null;
    if (c) {
      const enabled = c.tools.filter((x) => x.status === "enabled");
      tools = [
        ...enabled.map((x) => ({
          key: x.key,
          label: x.title ?? x.name,
          checked: picked.includes(x.name),
          unavailable: null,
        })),
        // a tool named by the agent that is off, waiting for review or gone stays, ticked
        ...picked
          .filter((n) => !enabled.some((x) => x.name === n))
          .map((n) => ({
            key: connectorToolKey(c.slug, n),
            label: c.tools.find((x) => x.name === n)?.title ?? n,
            checked: true,
            unavailable: t("form.connectorToolUnavailable"),
          })),
      ];
    }
    return {
      id: `app:${a.id}`,
      kind: "connector",
      name: a.name,
      tools,
      readError: detailFailed.has(a.id),
      onCheck: (keys, on) =>
        checkConnector(
          a.id,
          keys.flatMap((k) => {
            const p = parseToolKey(k);
            return p?.kind === "connector" ? [p.tool] : [];
          }),
          on,
        ),
    };
  });
  const groups = [...extensionGroups, ...connectorGroups];
  const openGroup = groups.find((g) => g.id === open) ?? null;

  /**
   * The referenced tool keys (for tightening): the builtins, the selected extension tools and the
   * selected connectors' ticked tools.
   */
  const toolKeys = [
    ...d.builtins,
    ...d.extensionTools.map(refKeyOf),
    ...Object.keys(d.connectors).flatMap((id) => {
      const c = connectorDetails[id];
      return c ? pickedNames(id).map((n) => connectorToolKey(c.slug, n)) : [];
    }),
  ];

  const setPolicy = (key: string, v: string) =>
    edit((cur) => {
      const policies = { ...cur.policies };
      if (v === "") delete policies[key];
      else policies[key] = v as TightenedPolicy;
      return { ...cur, policies };
    });
  const policyOptions = [
    { value: "", label: t("form.policy.default") },
    { value: "ask", label: t("form.policy.ask") },
    { value: "deny", label: t("form.policy.deny") },
  ];
  /** A row's policy: the tightened one of a ticked tool, else the default. */
  const policyOf = (key: string, checked: boolean) => (checked ? (d.policies[key] ?? "") : "");
  const rowsOf = (tools: GroupTool[]): ToolPolicyRow[] =>
    tools.map((x) => ({
      id: x.key,
      label: x.label,
      checked: x.checked,
      policy: policyOf(x.key, x.checked),
      ...(x.unavailable !== null ? { note: { text: x.unavailable, tone: "warn" as const } } : {}),
    }));

  /** A group row's summary: 已启用 n/m 个工具 · k 个需审批. */
  const summaryOf = (g: Group): string => {
    if (g.tools === null) {
      const used = g.kind === "connector" && d.connectors[g.id.slice(4)] !== undefined;
      return used ? t("form.groupUsed") : t("form.groupUnused");
    }
    const on = g.tools.filter((x) => x.checked);
    const asks = on.filter((x) => d.policies[x.key] === "ask").length;
    const denies = on.filter((x) => d.policies[x.key] === "deny").length;
    return [
      t("form.groupSummary", { on: on.length, total: g.tools.length }),
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
    ...(g.tools?.some((x) => x.unavailable !== null)
      ? { status: { label: t("form.groupUnavailable") } }
      : {}),
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
    !sameJson(sorted(d.extensionTools.map(refKeyOf)), sorted(saved.extensionTools.map(refKeyOf))),
    !sameJson(pickForm(d.connectors), pickForm(saved.connectors)),
    !sameJson(d.policies, saved.policies),
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending) return;
    const picked: AgentToolRef[] = [
      ...d.builtins.map((name) => ({ kind: "builtin" as const, name })),
      ...d.extensionTools.map((r) => ({ kind: "plugin" as const, plugin: r.plugin, name: r.name })),
      ...Object.entries(d.connectors).map(([connectorId, tools]) => ({
        kind: "connector" as const,
        connectorId,
        tools,
      })),
    ];
    // a policy of a tool this section manages goes with it; the others stay as saved
    const managed = (k: string) => {
      const p = parseToolKey(k);
      return (
        BUILTIN_SET.has(k) ||
        p?.kind === "extension" ||
        Object.values(connectorDetails).some(
          (a) => a.tools.some((x) => x.key === k) || (p?.kind === "connector" && p.slug === a.slug),
        )
      );
    };
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
          <Subsection variant="divided" title={t("form.builtinLabel")}>
            <ToolPolicyList
              label={t("form.builtinLabel")}
              policyOptions={policyOptions}
              disabled={save.pending}
              rows={listedBuiltins.map((name) => {
                const checked = d.builtins.includes(name);
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
                  builtins: on ? [...cur.builtins, name] : cur.builtins.filter((x) => x !== name),
                }))
              }
              onPolicy={setPolicy}
            />
            {webUnavailable && (
              <Text variant="prose" tone="muted">
                {t("form.webUnavailable")}
              </Text>
            )}
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
                <Text variant="prose" tone="muted">
                  {t("form.groupNoTools")}
                </Text>
              ) : (
                <ToolPolicyList
                  label={t("form.sheetTools", { name: openGroup.name })}
                  policyOptions={policyOptions}
                  disabled={save.pending}
                  rows={rowsOf(openGroup.tools)}
                  onCheck={(key, on) => openGroup.onCheck([key], on)}
                  onCheckAll={(keys, on) => openGroup.onCheck(keys, on)}
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
