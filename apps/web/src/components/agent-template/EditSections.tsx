"use client";

import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormSection,
  Input,
  ItemList,
  ItemListItem,
  Select,
  Stack,
  Subsection,
  Text,
  Textarea,
  ToolPolicyList,
  type ToolPolicyRow,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useRef, useState } from "react";
import {
  type EndpointProblem,
  endpointIndexOf,
  endpointProblem,
  TEMPLATE_EFFORTS,
  TEMPLATE_LIMITS,
  TEMPLATE_NAME_RE,
  type TemplateConnector,
  type TemplateEffort,
  type TemplateInlineSubagent,
} from "../../lib/agent-templates";
import {
  AGENT_TIERS,
  type AgentTier,
  BUILTIN_TOOLS,
  type TightenedPolicy,
  WEB_TOOL_POINTS,
} from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import { labelLocale, modelLabel } from "../../lib/extension-label";
import { joinInstructionFiles, readInstructionFiles } from "../../lib/instruction-files";
import {
  agentTemplatesQuery,
  availableExtensionPointsQuery,
  extensionToolsQuery,
} from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { orgComponentsQuery } from "../../lib/query/components";
import { modelsQuery } from "../../lib/query/conversation";
import { skillsQuery } from "../../lib/query/skills";
import { extensionToolKey, parseToolKey } from "../../lib/tool-key";
import { sameJson } from "../agent/definition-parts";
import { useSectionActionRow } from "../agent/definition-save";
import { useInstructionFilesEditor } from "../agent/InstructionFilesEditor";
import {
  QUICK_ACTIONS_MAX,
  type QuickActionEntry,
  QuickActionsEditor,
  quickActionEntries,
  quickActionInvalid,
  quickActionsOf,
} from "../agent/QuickActionsEditor";
import { useSectionDraft } from "../agent/useSectionDraft";
import { navLevelOf } from "../shell/nav";
import { useSession } from "../shell/session";
import {
  type TemplateSave,
  TemplateSaveFeedback,
  TemplateSectionFrame,
  useTemplatePage,
  useTemplateSave,
  withDefinition,
} from "./frame";
import { useConnectorTemplateName, useToolName } from "./labels";

/**
 * The template editor's sections (ruling P4-12), for owner-org admins: each edits its part of the
 * definition over the saved one and saves the whole definition as a new version (`useTemplateSave`,
 * with `expectedVersion`). Each keeps its own draft and action row, as the agent page's sections.
 */

/** Lines of a textarea as a list: trimmed, empty ones and repeats dropped. */
const linesOf = (text: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  ),
];
const textOf = (list: readonly string[] | undefined) => (list ?? []).join("\n");

/** The common shape of an editing section: feedback above its one box, the action row. */
function EditFrame({
  save,
  unsaved,
  errors,
  onSave,
  onDiscard,
  disabled,
  extra,
  children,
}: {
  save: TemplateSave;
  unsaved: number;
  errors: number;
  onSave(): void;
  onDiscard(): void;
  disabled?: boolean;
  extra?: string[];
  children: ReactNode;
}) {
  const actionRow = useSectionActionRow();
  const discard = () => {
    onDiscard();
    save.clear();
  };
  return (
    <TemplateSectionFrame
      dirty={unsaved > 0}
      actionRow={actionRow({
        unsaved,
        errors: errors + (save.error ? 1 : 0),
        pending: save.pending,
        onDiscard: discard,
        onSave,
        ...(disabled !== undefined ? { disabled } : {}),
      })}
    >
      <Stack gap={16}>
        <TemplateSaveFeedback
          save={save}
          onReload={() => void save.reload(onDiscard)}
          {...(extra !== undefined ? { extra } : {})}
        />
        {children}
      </Stack>
    </TemplateSectionFrame>
  );
}

/** 基本信息: the name (fixed: it is the roster type) and the description. */
export function BasicsEdit() {
  const t = useTranslations("agents.templatePage");
  const { template, definition } = useTemplatePage();
  const save = useTemplateSave();
  const draft = useSectionDraft({ description: definition.description });
  const [checked, setChecked] = useState(false);
  const description = draft.draft.description;
  const empty = description.trim() === "";
  const unsaved = description !== definition.description ? 1 : 0;

  async function onSave() {
    if (save.pending) return;
    setChecked(true);
    if (empty) return;
    const r = await save.send(withDefinition(template, { description: description.trim() }));
    if (r.saved) {
      draft.reset();
      setChecked(false);
    }
  }

  return (
    <EditFrame
      save={save}
      unsaved={unsaved}
      errors={checked && empty ? 1 : 0}
      onSave={() => void onSave()}
      onDiscard={() => {
        draft.reset();
        setChecked(false);
      }}
    >
      <FormSection id="basics" title={t("sections.basics")}>
        <Field label={t("basics.name")} help={t("basics.nameFixed")}>
          <Input name="name" value={template.name} disabled />
        </Field>
        <Field
          label={t("basics.description")}
          required
          count={{ value: description.length, max: TEMPLATE_LIMITS.descriptionChars }}
          {...(checked && empty ? { error: t("basics.descriptionRequired") } : {})}
        >
          <Textarea
            name="description"
            rows={4}
            disabled={save.pending}
            maxLength={TEMPLATE_LIMITS.descriptionChars}
            value={description}
            onChange={(e) => {
              save.begin();
              draft.set({ description: e.target.value });
            }}
          />
        </Field>
      </FormSection>
    </EditFrame>
  );
}

/** 快捷操作: the agent page's editor over `quickActions`. */
export function QuickActionsEdit() {
  const t = useTranslations("agents.templatePage");
  const tq = useTranslations("agents.page.quickActions");
  const { template, definition } = useTemplatePage();
  const save = useTemplateSave();
  const saved = { items: quickActionEntries(definition.quickActions ?? []) };
  const draft = useSectionDraft<{ items: QuickActionEntry[] }>(saved);
  const [checked, setChecked] = useState(false);
  const items = draft.draft.items;
  const bad = items.filter((e) => quickActionInvalid(e).title || quickActionInvalid(e).body);
  const unsaved =
    draft.dirty && !sameJson(quickActionsOf(items), quickActionsOf(saved.items)) ? 1 : 0;

  async function onSave() {
    if (save.pending) return;
    setChecked(true);
    if (bad.length > 0) return;
    const list = quickActionsOf(items);
    const r = await save.send(
      withDefinition(template, {
        quickActions: list.length === 0 && definition.quickActions === undefined ? undefined : list,
      }),
    );
    if (r.saved) {
      draft.reset();
      setChecked(false);
    }
  }

  return (
    <EditFrame
      save={save}
      unsaved={unsaved}
      errors={checked ? bad.length : 0}
      onSave={() => void onSave()}
      onDiscard={() => {
        draft.reset();
        setChecked(false);
      }}
    >
      <FormSection
        id="quick-actions"
        title={t("sections.quick-actions")}
        description={tq("hint", { max: QUICK_ACTIONS_MAX })}
      >
        <QuickActionsEditor
          items={items}
          edit={(fn) => {
            save.begin();
            draft.set((d) => ({ items: fn(d.items) }));
          }}
          pending={save.pending}
          checked={checked}
        />
      </FormSection>
    </EditFrame>
  );
}

/** 提示词: the agent page's file editor; the save writes the files and their join. */
export function PromptEdit() {
  const t = useTranslations("agents.templatePage");
  const tp = useTranslations("agents.page.prompt");
  const { template, definition } = useTemplatePage();
  const save = useTemplateSave();
  const files = useInstructionFilesEditor(
    readInstructionFiles(definition),
    save.pending,
    save.begin,
  );

  async function onSave() {
    if (save.pending || !files.check()) return;
    const r = await save.send(
      withDefinition(template, {
        instructionFiles: files.files,
        instructions: joinInstructionFiles(files.files),
      }),
    );
    if (r.saved) files.saved();
  }

  return (
    <EditFrame
      save={save}
      unsaved={files.unsaved}
      errors={files.errors}
      onSave={() => void onSave()}
      onDiscard={files.discard}
    >
      <FormSection
        id="prompt"
        layout="stacked"
        title={t("sections.prompt")}
        description={tp("hint")}
      >
        {files.editor}
      </FormSection>
    </EditFrame>
  );
}

/** 模型: the tier, an optional concrete model (`modelRef`, ruling P4-4) and the effort. */
export function ModelEdit() {
  const t = useTranslations("agents.templatePage");
  const lang = labelLocale(useLocale());
  const { orgId, template, definition } = useTemplatePage();
  const save = useTemplateSave();
  const mq = modelsQuery(orgId);
  const models = useQuery({ ...mq, retryOnMount: retryOnMountOf(mq.queryKey) });
  const saved = {
    model: definition.model ?? "standard",
    modelRef: definition.modelRef ?? "",
    effort: definition.effort ?? "",
  };
  const draft = useSectionDraft(saved);
  const d = draft.draft;
  const options = (models.data?.providers ?? []).flatMap((p) =>
    p.models.map((m) => ({
      value: `${p.provider}/${m.id}`,
      label: modelLabel(
        { name: p.provider, displayName: p.displayName },
        m.displayName || m.id,
        lang,
      ),
    })),
  );
  // a saved model the org cannot use now stays selectable as it is
  const known = options.some((o) => o.value === d.modelRef);
  const unsaved = [
    d.model !== saved.model,
    d.modelRef !== saved.modelRef,
    d.effort !== saved.effort,
  ].filter(Boolean).length;
  const edit = (patch: Partial<typeof saved>) => {
    save.begin();
    draft.set(patch);
  };

  async function onSave() {
    if (save.pending) return;
    const r = await save.send(
      withDefinition(template, {
        model: d.model as AgentTier,
        modelRef: d.modelRef === "" ? undefined : d.modelRef,
        effort: d.effort === "" ? undefined : (d.effort as TemplateEffort),
      }),
    );
    if (r.saved) draft.reset();
  }

  return (
    <EditFrame
      save={save}
      unsaved={unsaved}
      errors={0}
      onSave={() => void onSave()}
      onDiscard={draft.reset}
    >
      <FormSection id="model" title={t("sections.model")} description={t("model.hint")}>
        <Field label={t("model.tier")} help={t("model.tierHelp")}>
          <Select
            name="tier"
            disabled={save.pending}
            value={d.model}
            onChange={(e) => edit({ model: e.target.value as AgentTier })}
            options={AGENT_TIERS.map((x) => ({ value: x, label: t(`tier.${x}`) }))}
          />
        </Field>
        <Field label={t("model.modelRef")} optional help={t("model.modelRefHelp")}>
          <Select
            name="modelRef"
            disabled={save.pending}
            value={d.modelRef}
            onChange={(e) => edit({ modelRef: e.target.value })}
            options={[
              { value: "", label: t("model.noModelRef") },
              ...options,
              ...(d.modelRef !== "" && !known
                ? [{ value: d.modelRef, label: t("model.unavailableModel", { model: d.modelRef }) }]
                : []),
            ]}
          />
        </Field>
        <Field label={t("model.effort")} optional>
          <Select
            name="effort"
            disabled={save.pending}
            value={d.effort}
            onChange={(e) => edit({ effort: e.target.value as TemplateEffort | "" })}
            options={[
              { value: "", label: t("model.noEffort") },
              ...TEMPLATE_EFFORTS.map((x) => ({ value: x, label: t(`effort.${x}`) })),
            ]}
          />
        </Field>
      </FormSection>
    </EditFrame>
  );
}

/**
 * 工具 (tools default-on spec §9): an agent created from the template has every tool the org
 * offers, so every checkbox means on / off and starts checked; unchecking writes the key to the
 * template's `disallowedTools`. Rows are the builtins, the tools of the extensions enabled in the
 * org (by group), and any other key the template turns off (kept unticked; ticking drops it), each
 * with its tightened policy (`ToolPolicyList`). A save never writes the old `tools` allowlist.
 */
export function ToolsEdit() {
  const t = useTranslations("agents.templatePage");
  const tf = useTranslations("agents.form");
  const lang = labelLocale(useLocale());
  const { orgId, template, definition } = useTemplatePage();
  const toolName = useToolName();
  const save = useTemplateSave();
  const extQ = extensionToolsQuery(orgId);
  const ext = useQuery({ ...extQ, retryOnMount: retryOnMountOf(extQ.queryKey) });
  const pointsQ = availableExtensionPointsQuery(orgId);
  const points = useQuery({ ...pointsQ, retryOnMount: retryOnMountOf(pointsQ.queryKey) });
  const saved = {
    off: definition.disallowedTools ?? [],
    policies: definition.toolPolicies ?? {},
  };
  const draft = useSectionDraft(saved);
  const d = draft.draft;
  const available = new Set(
    (points.data?.points ?? []).filter((p) => p.available).map((p) => p.point),
  );
  const builtins = BUILTIN_TOOLS.filter((name) => {
    const point = WEB_TOOL_POINTS[name];
    return point === undefined || available.has(point) || saved.off.includes(name);
  });
  const groups = (ext.data?.extensions ?? []).map((e) => ({
    plugin: e.plugin,
    name: e.displayName[lang],
    tools: e.tools.map((x) => ({
      key: extensionToolKey(e.plugin, x.name),
      label: x.title ?? x.name,
      switchedOff: x.switchedOff === true,
    })),
  }));
  const listed = new Set<string>([
    ...builtins,
    ...groups.flatMap((g) => g.tools.map((x) => x.key)),
  ]);
  // keys the template turns off that this org does not list (another org's extension, a
  // connector key): kept off; ticking one drops it from the template
  const others = [...new Set([...saved.off, ...d.off])].filter((k) => !listed.has(k));
  const check = (keys: string[], on: boolean) => {
    save.begin();
    draft.set((cur) => ({
      ...cur,
      off: on ? cur.off.filter((x) => !keys.includes(x)) : [...new Set([...cur.off, ...keys])],
    }));
  };
  const setPolicy = (key: string, v: string) => {
    save.begin();
    draft.set((cur) => {
      const policies = { ...cur.policies };
      if (v === "") delete policies[key];
      else policies[key] = v as TightenedPolicy;
      return { ...cur, policies };
    });
  };
  const policyOptions = [
    { value: "", label: tf("policy.default") },
    { value: "ask", label: tf("policy.ask") },
    { value: "deny", label: tf("policy.deny") },
  ];
  const row = (key: string, label: string, note?: string): ToolPolicyRow => {
    const checked = !d.off.includes(key);
    return {
      id: key,
      label,
      checked,
      policy: checked ? (d.policies[key] ?? "") : "",
      ...(note !== undefined && checked ? { note: { text: note, tone: "warn" as const } } : {}),
    };
  };
  const list = (label: string, rows: ToolPolicyRow[]) => (
    <ToolPolicyList
      label={label}
      policyOptions={policyOptions}
      disabled={save.pending}
      rows={rows}
      onCheck={(key, on) => check([key], on)}
      onCheckAll={(keys, on) => check(keys, on)}
      onPolicy={setPolicy}
    />
  );
  const unsaved = [
    !sameJson([...d.off].sort(), [...saved.off].sort()),
    !sameJson(d.policies, saved.policies),
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending) return;
    const off = [...new Set(d.off)];
    const r = await save.send(
      withDefinition(template, {
        // tools default-on: no allowlist; the template turns off what is unticked
        tools: undefined,
        disallowedTools:
          off.length === 0 && definition.disallowedTools === undefined ? undefined : off,
        // a policy stays with its tool, on or off
        toolPolicies:
          Object.keys(d.policies).length === 0 && definition.toolPolicies === undefined
            ? undefined
            : d.policies,
      }),
    );
    if (r.saved) draft.reset();
  }

  return (
    <EditFrame
      save={save}
      unsaved={unsaved}
      errors={0}
      onSave={() => void onSave()}
      onDiscard={draft.reset}
    >
      <FormSection id="tools" title={t("sections.tools")} description={t("tools.hint")}>
        <Subsection variant="divided" title={tf("builtinLabel")}>
          {list(
            tf("builtinLabel"),
            builtins.map((name) => row(name, tf(`builtin.${name}`))),
          )}
        </Subsection>
        <Subsection variant="divided" title={tf("extensionToolsLabel")}>
          {groups.length === 0 && ext.data !== undefined ? (
            <Text variant="small" tone="faint">
              {tf("noExtensionTools")}
            </Text>
          ) : null}
          {ext.isError ? (
            <Text variant="small" tone="faint">
              {tf("extensionToolsUnreadable")}
            </Text>
          ) : null}
          {groups.map((g) => (
            <Stack key={g.plugin} gap={4}>
              <Text variant="small">{g.name}</Text>
              {list(
                g.name,
                g.tools.map((x) =>
                  row(x.key, x.label, x.switchedOff ? tf("extensionToolOffInOrg") : undefined),
                ),
              )}
            </Stack>
          ))}
        </Subsection>
        {others.length > 0 ? (
          <Subsection variant="divided" title={t("tools.others")}>
            {list(
              t("tools.others"),
              others.map((key) =>
                row(
                  key,
                  parseToolKey(key)?.kind === "builtin"
                    ? toolName(key)
                    : t("tools.unavailable", { tool: toolName(key) }),
                ),
              ),
            )}
            <Text variant="small" tone="faint">
              {t("tools.othersHint")}
            </Text>
          </Subsection>
        ) : null}
      </FormSection>
    </EditFrame>
  );
}

/**
 * 技能: the skills by name (a template carries names, ruling P4-1): pick from the org's skills,
 * and preload (pin) up to 3 of the picked ones. A name the org does not have stays picked and is
 * marked (用它创建 leaves it out); unticking drops it. Two titled regions in the card, as on the
 * agent page: the org skills (the panel empty state, linking to the skills page for members) and
 * the pinned ones (the count against the limit at the heading's right; with nothing selected, one
 * short line where the pin list would be).
 */
export function SkillsEdit() {
  const t = useTranslations("agents.templatePage");
  const { orgId, template, definition } = useTemplatePage();
  const { me } = useSession();
  const save = useTemplateSave();
  const sq = skillsQuery(orgId);
  const skills = useQuery({ ...sq, retryOnMount: retryOnMountOf(sq.queryKey) });
  const saved = {
    selected: [...(definition.skills ?? []), ...(definition.selectedSkills ?? [])],
    pinned: definition.skills ?? [],
  };
  const draft = useSectionDraft(saved);
  const d = draft.draft;
  const org = (skills.data?.skills ?? []).filter((s) => s.scope !== "agent");
  const orgNames = new Set(org.map((s) => s.name));
  const missing = [...new Set([...saved.selected, ...d.selected])].filter((n) => !orgNames.has(n));
  const edit = (fn: (cur: typeof saved) => typeof saved) => {
    save.begin();
    draft.set(fn);
  };
  const toggle = (name: string, on: boolean) =>
    edit((cur) => ({
      selected: on ? [...cur.selected, name] : cur.selected.filter((x) => x !== name),
      pinned: on ? cur.pinned : cur.pinned.filter((x) => x !== name),
    }));
  const tooMany = d.selected.length - d.pinned.length > TEMPLATE_LIMITS.selectedSkills;
  const unsaved = [
    !sameJson([...d.selected].sort(), [...saved.selected].sort()),
    !sameJson(d.pinned, saved.pinned),
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending || tooMany) return;
    const rest = d.selected.filter((n) => !d.pinned.includes(n));
    const r = await save.send(
      withDefinition(template, {
        skills: d.pinned.length === 0 && definition.skills === undefined ? undefined : d.pinned,
        selectedSkills:
          rest.length === 0 && definition.selectedSkills === undefined ? undefined : rest,
      }),
    );
    if (r.saved) draft.reset();
  }

  return (
    <EditFrame
      save={save}
      unsaved={unsaved}
      errors={tooMany ? 1 : 0}
      onSave={() => void onSave()}
      onDiscard={draft.reset}
    >
      <FormSection id="skills" title={t("sections.skills")} description={t("skills.hint")}>
        <Subsection variant="divided" title={t("skills.selectLabel")}>
          <Stack gap={4}>
            {org.length === 0 && missing.length === 0 && skills.data !== undefined ? (
              <EmptyState
                size="panel"
                text={t("skills.noOrgSkills")}
                {...(navLevelOf(me) === "guest"
                  ? {}
                  : {
                      action: {
                        label: t("skills.goToSkills"),
                        variant: "default" as const,
                        href: "/skills",
                      },
                    })}
              />
            ) : null}
            {skills.isError ? (
              <Text variant="small" tone="faint">
                {t("skills.unreadable")}
              </Text>
            ) : null}
            {org.map((s) => (
              <Checkbox
                key={s.id}
                label={s.description === "" ? s.name : `${s.name} · ${s.description}`}
                checked={d.selected.includes(s.name)}
                disabled={save.pending}
                onChange={(on) => toggle(s.name, on)}
              />
            ))}
            {missing.map((name) => (
              <Checkbox
                key={`missing:${name}`}
                label={t("skills.missing", { name })}
                checked={d.selected.includes(name)}
                disabled={save.pending}
                onChange={(on) => toggle(name, on)}
              />
            ))}
            {tooMany ? (
              <Text variant="small" tone="fail">
                {t("skills.tooMany", { max: TEMPLATE_LIMITS.selectedSkills })}
              </Text>
            ) : null}
          </Stack>
        </Subsection>
        <Subsection
          variant="divided"
          title={t("skills.pinLabel")}
          description={t("skills.pinHint")}
          actions={
            <Text variant="small" tone="faint">
              {t("skills.pinCount", { count: d.pinned.length, max: TEMPLATE_LIMITS.skills })}
            </Text>
          }
        >
          <Stack gap={4}>
            {d.selected.length === 0 ? (
              <Text variant="small" tone="faint">
                {t("skills.noneToPin")}
              </Text>
            ) : null}
            {d.selected.map((name) => {
              const pinned = d.pinned.includes(name);
              return (
                <Checkbox
                  key={`pin:${name}`}
                  label={t("skills.pin", { name })}
                  checked={pinned}
                  disabled={save.pending || (!pinned && d.pinned.length >= TEMPLATE_LIMITS.skills)}
                  onChange={(on) =>
                    edit((cur) => ({
                      ...cur,
                      pinned: on ? [...cur.pinned, name] : cur.pinned.filter((x) => x !== name),
                    }))
                  }
                />
              );
            })}
          </Stack>
        </Subsection>
      </FormSection>
    </EditFrame>
  );
}

/** A connector entry as the editor holds it: the tools as text, a stable key. */
type ConnectorDraft = {
  key: string;
  kind: "template" | "needs";
  template: string;
  protocol: "mcp" | "openapi";
  endpoint: string;
  label: string;
  /** One tool name per line; empty on a template entry = all its tools. */
  toolsText: string;
  policies: Record<string, TightenedPolicy>;
};

const connectorDraftOf = (c: TemplateConnector, i: number): ConnectorDraft =>
  "needs" in c
    ? {
        key: `saved-${i}`,
        kind: "needs",
        template: "",
        protocol: c.needs.protocol,
        endpoint: c.needs.endpoint,
        label: c.needs.label,
        toolsText: textOf(c.needs.tools),
        policies: c.policies ?? {},
      }
    : {
        key: `saved-${i}`,
        kind: "template",
        template: c.template,
        protocol: "mcp",
        endpoint: "",
        label: "",
        toolsText: textOf(c.tools),
        policies: c.policies ?? {},
      };

/** What a draft entry saves; the policies follow the tools that stay named. */
function connectorOf(d: ConnectorDraft): TemplateConnector {
  const tools = linesOf(d.toolsText);
  const keep = (names: string[] | undefined) => {
    const p = Object.fromEntries(
      Object.entries(d.policies).filter(([k]) => names === undefined || names.includes(k)),
    );
    return Object.keys(p).length === 0 ? {} : { policies: p };
  };
  if (d.kind === "template") {
    const named = tools.length === 0 ? undefined : tools;
    return {
      template: d.template,
      ...(named !== undefined ? { tools: named } : {}),
      ...keep(named),
    };
  }
  return {
    needs: { protocol: d.protocol, endpoint: d.endpoint.trim(), tools, label: d.label.trim() },
    ...keep(tools),
  };
}

/**
 * A connector entry's tool policies (ruling P4-5: they carry over for kept tools): one select per
 * listed tool, as the Tools section's; an entry naming no tools (a template entry: all its tools)
 * keeps its saved policies read-only and says so.
 */
function ConnectorPolicies({
  entry,
  disabled,
  onChange,
}: {
  entry: ConnectorDraft;
  disabled: boolean;
  onChange(tool: string, v: TightenedPolicy | ""): void;
}) {
  const t = useTranslations("agents.templatePage");
  const tf = useTranslations("agents.form");
  const tools = linesOf(entry.toolsText);
  if (tools.length === 0) {
    const kept = Object.entries(entry.policies);
    return kept.length === 0 ? null : (
      <Text variant="small" tone="muted">
        {t("connectors.policiesKept", {
          count: kept.length,
          list: kept.map(([tool, p]) => `${tool} · ${t(`policy.${p}`)}`).join(", "),
        })}
      </Text>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings browser styles; apps/web writes none
    <div role="group" aria-label={t("connectors.policies")}>
      <Stack gap={4}>
        <Text variant="small" tone="muted">
          {t("connectors.policies")}
        </Text>
        {tools.map((tool) => (
          <Field key={tool} label={tool}>
            <Select
              value={entry.policies[tool] ?? ""}
              disabled={disabled}
              onChange={(e) => onChange(tool, e.target.value as TightenedPolicy | "")}
              options={[
                { value: "", label: tf("policy.default") },
                { value: "ask", label: tf("policy.ask") },
                { value: "deny", label: tf("policy.deny") },
              ]}
            />
          </Field>
        ))}
      </Stack>
    </div>
  );
}

/**
 * 连接器: the template entries (a platform connector template, by name) and the needs entries (a
 * connector by protocol, endpoint and tools; ruling P4-11, never credentials). Needs entries are
 * edited in place and may be added; any entry may be removed. An endpoint carrying userinfo, a
 * query or a fragment is refused here and by the kernel, with the clean form to use.
 */
export function ConnectorsEdit() {
  const t = useTranslations("agents.templatePage");
  const { orgId, template, definition } = useTemplatePage();
  const templateName = useConnectorTemplateName();
  const save = useTemplateSave();
  const cq = orgComponentsQuery(orgId, {});
  const offered = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) });
  const [picked, setPicked] = useState("");
  const savedList = definition.connectors ?? [];
  const saved = { items: savedList.map(connectorDraftOf) };
  const draft = useSectionDraft(saved);
  const items = draft.draft.items;
  const [checked, setChecked] = useState(false);
  const [serverEndpoints, setServerEndpoints] = useState<Record<number, true>>({});
  const next = useRef(0);
  const edit = (fn: (items: ConnectorDraft[]) => ConnectorDraft[]) => {
    save.begin();
    draft.set((d) => ({ items: fn(d.items) }));
  };
  const update = (key: string, patch: Partial<ConnectorDraft>) => {
    setServerEndpoints({});
    edit((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  };

  const endpointText = (p: EndpointProblem): string =>
    p.kind === "invalid"
      ? t("connectors.endpointInvalid")
      : t("connectors.endpointCarries", {
          parts: p.parts.map((x) => t(`connectors.part.${x}`)).join(t("connectors.partSep")),
          clean: p.clean,
        });
  const problems = items.map((x, i) => {
    if (x.kind !== "needs") return {};
    const p = endpointProblem(x.endpoint);
    return {
      ...(x.label.trim() === "" ? { label: t("connectors.labelRequired") } : {}),
      ...(p !== null
        ? { endpoint: endpointText(p) }
        : serverEndpoints[i]
          ? { endpoint: t("connectors.endpointRefused") }
          : {}),
    };
  });
  const shown = (i: number) =>
    checked ? (problems[i] ?? {}) : serverEndpoints[i] ? (problems[i] ?? {}) : {};
  const errorCount = items.reduce((n, _, i) => n + Object.keys(shown(i)).length, 0);
  const unsaved =
    draft.dirty && !sameJson(items.map(connectorOf), saved.items.map(connectorOf)) ? 1 : 0;
  // the connector templates on in the org that the template does not name yet
  const addable = (offered.data?.components ?? []).filter(
    (c) =>
      c.kind === "connector_template" &&
      c.on &&
      !items.some((x) => x.kind === "template" && x.template === c.id),
  );
  const full = items.length >= TEMPLATE_LIMITS.connectors;
  const add = (entry: Omit<ConnectorDraft, "key">) => {
    next.current += 1;
    const key = `new-${next.current}`;
    edit((list) => [...list, { key, ...entry }]);
  };
  const setPolicy = (key: string, tool: string, v: TightenedPolicy | "") =>
    edit((list) =>
      list.map((x) => {
        if (x.key !== key) return x;
        const policies = { ...x.policies };
        if (v === "") delete policies[tool];
        else policies[tool] = v;
        return { ...x, policies };
      }),
    );

  async function onSave() {
    if (save.pending) return;
    setChecked(true);
    setServerEndpoints({});
    if (problems.some((p) => Object.keys(p).length > 0)) return;
    const list = items.map(connectorOf);
    const r = await save.send(
      withDefinition(template, {
        connectors: list.length === 0 && definition.connectors === undefined ? undefined : list,
      }),
    );
    if (r.saved) {
      draft.reset();
      setChecked(false);
      return;
    }
    // the kernel's endpoint refusals land on their fields (its words stay behind 原始错误)
    if (r.error instanceof ApiClientError && r.error.code === "validation_failed") {
      const at: Record<number, true> = {};
      for (const x of r.error.details) {
        const i = endpointIndexOf(x.path);
        if (i !== null) at[i] = true;
      }
      setServerEndpoints(at);
    }
  }

  return (
    <EditFrame
      save={save}
      unsaved={unsaved}
      errors={errorCount}
      onSave={() => void onSave()}
      onDiscard={() => {
        draft.reset();
        setChecked(false);
        setServerEndpoints({});
      }}
    >
      <FormSection
        id="connectors"
        title={t("sections.connectors")}
        description={t("connectors.hint")}
      >
        <ItemList label={t("connectors.list")} empty={t("connectors.none")}>
          {items.map((x, i) => {
            const p = shown(i);
            const title =
              x.kind === "needs" ? x.label || t("connectors.newNeeds") : templateName(x.template);
            return (
              <ItemListItem
                key={x.key}
                title={title}
                invalid={Object.keys(p).length > 0}
                meta={
                  x.kind === "needs"
                    ? t("connectors.needsKind", {
                        protocol: t(`connectors.protocol.${x.protocol}`),
                      })
                    : t("connectors.templateKind")
                }
                actions={
                  <Button
                    variant="ghost"
                    density="dense"
                    disabled={save.pending}
                    aria-label={t("connectors.removeLabel", { name: title })}
                    onClick={() => {
                      setServerEndpoints({});
                      edit((list) => list.filter((y) => y.key !== x.key));
                    }}
                  >
                    {t("connectors.remove")}
                  </Button>
                }
              >
                <Stack gap={8}>
                  {x.kind === "needs" ? (
                    <>
                      <Field
                        label={t("connectors.label")}
                        required
                        count={{ value: x.label.length, max: TEMPLATE_LIMITS.labelChars }}
                        {...(p.label !== undefined ? { error: p.label } : {})}
                      >
                        <Input
                          value={x.label}
                          maxLength={TEMPLATE_LIMITS.labelChars}
                          disabled={save.pending}
                          onChange={(e) => update(x.key, { label: e.target.value })}
                        />
                      </Field>
                      <Field label={t("connectors.protocolLabel")}>
                        <Select
                          value={x.protocol}
                          disabled={save.pending}
                          onChange={(e) =>
                            update(x.key, { protocol: e.target.value as "mcp" | "openapi" })
                          }
                          options={(["mcp", "openapi"] as const).map((v) => ({
                            value: v,
                            label: t(`connectors.protocol.${v}`),
                          }))}
                        />
                      </Field>
                      <Field
                        label={t("connectors.endpoint")}
                        required
                        help={t("connectors.endpointHelp")}
                        {...(p.endpoint !== undefined ? { error: p.endpoint } : {})}
                      >
                        <Input
                          value={x.endpoint}
                          maxLength={TEMPLATE_LIMITS.endpointChars}
                          disabled={save.pending}
                          onChange={(e) => update(x.key, { endpoint: e.target.value })}
                        />
                      </Field>
                    </>
                  ) : null}
                  <Field
                    label={t("connectors.tools")}
                    optional={x.kind === "template"}
                    help={
                      x.kind === "template"
                        ? t("connectors.templateToolsHelp")
                        : t("connectors.needsToolsHelp")
                    }
                  >
                    <Textarea
                      rows={3}
                      disabled={save.pending}
                      value={x.toolsText}
                      onChange={(e) => update(x.key, { toolsText: e.target.value })}
                    />
                  </Field>
                  <ConnectorPolicies
                    entry={x}
                    disabled={save.pending}
                    onChange={(tool, v) => setPolicy(x.key, tool, v)}
                  />
                </Stack>
              </ItemListItem>
            );
          })}
        </ItemList>
        <Stack direction="row" gap={8} align="end" wrap>
          <Field label={t("connectors.addTemplateLabel")}>
            <Select
              name="add-template"
              value={picked}
              disabled={save.pending || full || addable.length === 0}
              onChange={(e) => setPicked(e.target.value)}
              options={[
                {
                  value: "",
                  label:
                    addable.length === 0
                      ? t("connectors.noTemplates")
                      : t("connectors.pickTemplate"),
                },
                ...addable.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </Field>
          <Button
            disabled={save.pending || full || picked === ""}
            onClick={() => {
              add({
                kind: "template",
                template: picked,
                protocol: "mcp",
                endpoint: "",
                label: "",
                toolsText: "",
                policies: {},
              });
              setPicked("");
            }}
          >
            {t("connectors.addTemplate")}
          </Button>
          <Button
            disabled={save.pending || full}
            onClick={() =>
              add({
                kind: "needs",
                template: "",
                protocol: "mcp",
                endpoint: "",
                label: "",
                toolsText: "",
                policies: {},
              })
            }
          >
            {t("connectors.addNeeds")}
          </Button>
        </Stack>
      </FormSection>
    </EditFrame>
  );
}

/** An inline sub-agent as the editor holds it. */
type InlineDraft = {
  key: string;
  name: string;
  description: string;
  instructions: string;
  model: AgentTier;
  /** `all`: no allowlist (every tool of the agent); `none`: `[]`; `list`: the keys in `toolsText`. */
  toolsMode: "all" | "none" | "list";
  toolsText: string;
  skillsText: string;
};

const inlineDraftOf = (x: TemplateInlineSubagent, i: number): InlineDraft => ({
  key: `saved-${i}`,
  name: x.name,
  description: x.description,
  instructions: x.instructions,
  model: x.model,
  toolsMode: x.tools === undefined ? "all" : x.tools.length === 0 ? "none" : "list",
  toolsText: textOf(x.tools),
  skillsText: textOf(x.skills),
});

function inlineOf(x: InlineDraft): TemplateInlineSubagent {
  const tools = linesOf(x.toolsText);
  return {
    name: x.name.trim(),
    description: x.description.trim(),
    instructions: x.instructions,
    model: x.model,
    skills: linesOf(x.skillsText),
    ...(x.toolsMode === "all" ? {} : { tools: x.toolsMode === "none" ? [] : tools }),
  };
}

/**
 * 子智能体: the general-purpose sub-agent, sub-agent types (templates usable in the org, by type;
 * a type the org cannot use stays picked and marked) and sub-agents described inline (name,
 * description, instructions, tier, tools: all / none / listed, skill names).
 */
export function SubagentsEdit() {
  const t = useTranslations("agents.templatePage");
  const ts = useTranslations("agents.form.subagents");
  const { orgId, template, definition } = useTemplatePage();
  const save = useTemplateSave();
  const tq = agentTemplatesQuery(orgId);
  const templates = useQuery({ ...tq, retryOnMount: retryOnMountOf(tq.queryKey) });
  const s = definition.subagents ?? {};
  const saved = {
    general: s.general === true,
    types: s.types ?? [],
    inline: (s.inline ?? []).map(inlineDraftOf),
  };
  const draft = useSectionDraft(saved);
  const d = draft.draft;
  const [checked, setChecked] = useState(false);
  const next = useRef(0);
  const edit = (fn: (cur: typeof saved) => typeof saved) => {
    save.begin();
    draft.set(fn);
  };
  const updateInline = (key: string, patch: Partial<InlineDraft>) =>
    edit((cur) => ({
      ...cur,
      inline: cur.inline.map((x) => (x.key === key ? { ...x, ...patch } : x)),
    }));
  const offered = (templates.data?.templates ?? []).filter((x) => x.type !== template.type);
  const offeredTypes = new Set(offered.map((x) => x.type));
  const unknown = [...new Set([...saved.types, ...d.types])].filter((x) => !offeredTypes.has(x));
  const inlineProblems = d.inline.map((x) => ({
    ...(TEMPLATE_NAME_RE.test(x.name.trim()) ? {} : { name: t("subagents.nameInvalid") }),
    ...(x.description.trim() === "" ? { description: t("subagents.descriptionRequired") } : {}),
    ...(x.instructions.trim() === "" ? { instructions: t("subagents.instructionsRequired") } : {}),
    ...(x.toolsMode === "list" && linesOf(x.toolsText).length === 0
      ? { tools: t("subagents.toolsListEmpty") }
      : {}),
    ...(linesOf(x.skillsText).length > TEMPLATE_LIMITS.skills
      ? { skills: t("subagents.tooManySkills", { max: TEMPLATE_LIMITS.skills }) }
      : {}),
  }));
  const tooMany = d.types.length + d.inline.length > TEMPLATE_LIMITS.subagentTypes;
  const errors =
    (checked ? inlineProblems.reduce((n, p) => n + Object.keys(p).length, 0) : 0) +
    (tooMany ? 1 : 0);
  const blockOf = (x: typeof saved) => ({
    general: x.general,
    types: x.types,
    inline: x.inline.map(inlineOf),
  });
  const unsaved = draft.dirty && !sameJson(blockOf(d), blockOf(saved)) ? 1 : 0;

  async function onSave() {
    if (save.pending) return;
    setChecked(true);
    if (tooMany || inlineProblems.some((p) => Object.keys(p).length > 0)) return;
    const inline = d.inline.map(inlineOf);
    const block = {
      ...(d.general || s.general !== undefined ? { general: d.general } : {}),
      ...(d.types.length > 0 || s.types !== undefined ? { types: d.types } : {}),
      ...(inline.length > 0 || s.inline !== undefined ? { inline } : {}),
    };
    const r = await save.send(
      withDefinition(template, {
        subagents:
          Object.keys(block).length === 0 && definition.subagents === undefined ? undefined : block,
      }),
    );
    if (r.saved) {
      draft.reset();
      setChecked(false);
    }
  }

  return (
    <EditFrame
      save={save}
      unsaved={unsaved}
      errors={errors}
      onSave={() => void onSave()}
      onDiscard={() => {
        draft.reset();
        setChecked(false);
      }}
    >
      <FormSection id="subagents" title={t("sections.subagents")} description={t("subagents.hint")}>
        <Checkbox
          label={ts("general")}
          checked={d.general}
          disabled={save.pending}
          onChange={(general) => edit((cur) => ({ ...cur, general }))}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset brings browser styles; apps/web writes none */}
        <div role="group" aria-label={ts("templatesLabel")}>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {ts("templatesLabel")}
            </Text>
            {offered.length === 0 && unknown.length === 0 ? (
              <Text variant="small" tone="faint">
                {ts("templatesNone")}
              </Text>
            ) : null}
            {offered.map((x) => (
              <Checkbox
                key={x.id}
                checked={d.types.includes(x.type)}
                disabled={save.pending}
                onChange={(on) =>
                  edit((cur) => ({
                    ...cur,
                    types: on ? [...cur.types, x.type] : cur.types.filter((y) => y !== x.type),
                  }))
                }
                label={
                  <Stack gap={0}>
                    <Text>{`${x.type} · ${ts(`tier.${x.model}`)}`}</Text>
                    <Text variant="small" tone="muted">
                      {x.description}
                    </Text>
                  </Stack>
                }
              />
            ))}
            {unknown.map((type) => (
              <Checkbox
                key={`unknown:${type}`}
                checked={d.types.includes(type)}
                disabled={save.pending}
                onChange={(on) =>
                  edit((cur) => ({
                    ...cur,
                    types: on ? [...cur.types, type] : cur.types.filter((y) => y !== type),
                  }))
                }
                label={t("subagents.typeUnavailable", { type })}
              />
            ))}
          </Stack>
        </div>
        <Stack gap={8}>
          <Text variant="small" tone="muted">
            {ts("inlineLabel")}
          </Text>
          <ItemList label={ts("inlineLabel")}>
            {d.inline.map((x, i) => {
              const p: Record<string, string> = checked ? (inlineProblems[i] ?? {}) : {};
              const title = x.name || ts("inlineNew");
              return (
                <ItemListItem
                  key={x.key}
                  title={title}
                  invalid={Object.keys(p).length > 0}
                  actions={
                    <Button
                      variant="ghost"
                      density="dense"
                      disabled={save.pending}
                      aria-label={ts("removeInline", { name: title })}
                      onClick={() =>
                        edit((cur) => ({
                          ...cur,
                          inline: cur.inline.filter((y) => y.key !== x.key),
                        }))
                      }
                    >
                      {ts("remove")}
                    </Button>
                  }
                >
                  <Stack gap={8}>
                    <Field
                      label={ts("inlineName")}
                      help={ts("inlineNameHelp")}
                      {...(p.name ? { error: p.name } : {})}
                    >
                      <Input
                        value={x.name}
                        maxLength={64}
                        disabled={save.pending}
                        onChange={(e) => updateInline(x.key, { name: e.target.value })}
                      />
                    </Field>
                    <Field
                      label={ts("inlineDescription")}
                      {...(p.description ? { error: p.description } : {})}
                    >
                      <Textarea
                        rows={2}
                        maxLength={TEMPLATE_LIMITS.descriptionChars}
                        disabled={save.pending}
                        value={x.description}
                        onChange={(e) => updateInline(x.key, { description: e.target.value })}
                      />
                    </Field>
                    <Field
                      label={ts("inlineInstructions")}
                      {...(p.instructions ? { error: p.instructions } : {})}
                    >
                      <Textarea
                        code
                        rows={4}
                        maxLength={TEMPLATE_LIMITS.inlineInstructionsChars}
                        disabled={save.pending}
                        value={x.instructions}
                        onChange={(e) => updateInline(x.key, { instructions: e.target.value })}
                      />
                    </Field>
                    <Field label={ts("inlineModel")}>
                      <Select
                        value={x.model}
                        disabled={save.pending}
                        onChange={(e) =>
                          updateInline(x.key, { model: e.target.value as AgentTier })
                        }
                        options={AGENT_TIERS.map((tier) => ({
                          value: tier,
                          label: ts(`tier.${tier}`),
                        }))}
                      />
                    </Field>
                    <Field label={t("subagents.tools")}>
                      <Select
                        value={x.toolsMode}
                        disabled={save.pending}
                        onChange={(e) =>
                          updateInline(x.key, {
                            toolsMode: e.target.value as InlineDraft["toolsMode"],
                          })
                        }
                        options={(["all", "none", "list"] as const).map((m) => ({
                          value: m,
                          label: t(`subagents.toolsMode.${m}`),
                        }))}
                      />
                    </Field>
                    {x.toolsMode === "list" ? (
                      <Field
                        label={t("subagents.toolKeys")}
                        help={t("subagents.toolKeysHelp")}
                        {...(p.tools ? { error: p.tools } : {})}
                      >
                        <Textarea
                          rows={3}
                          disabled={save.pending}
                          value={x.toolsText}
                          onChange={(e) => updateInline(x.key, { toolsText: e.target.value })}
                        />
                      </Field>
                    ) : null}
                    <Field
                      label={t("subagents.skills")}
                      optional
                      help={t("subagents.skillsHelp", { max: TEMPLATE_LIMITS.skills })}
                      {...(p.skills ? { error: p.skills } : {})}
                    >
                      <Textarea
                        rows={2}
                        disabled={save.pending}
                        value={x.skillsText}
                        onChange={(e) => updateInline(x.key, { skillsText: e.target.value })}
                      />
                    </Field>
                  </Stack>
                </ItemListItem>
              );
            })}
          </ItemList>
          <Stack direction="row" gap={8}>
            <Button
              disabled={
                save.pending || d.types.length + d.inline.length >= TEMPLATE_LIMITS.subagentTypes
              }
              onClick={() => {
                next.current += 1;
                const key = `new-${next.current}`;
                edit((cur) => ({
                  ...cur,
                  inline: [
                    ...cur.inline,
                    {
                      key,
                      name: "",
                      description: "",
                      instructions: "",
                      model: "inherit",
                      toolsMode: "all",
                      toolsText: "",
                      skillsText: "",
                    },
                  ],
                }));
              }}
            >
              {ts("addInline")}
            </Button>
          </Stack>
          {tooMany ? (
            <Text variant="small" tone="fail">
              {t("subagents.tooMany", { max: TEMPLATE_LIMITS.subagentTypes })}
            </Text>
          ) : null}
        </Stack>
      </FormSection>
    </EditFrame>
  );
}
