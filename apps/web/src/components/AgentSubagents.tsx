"use client";

import {
  Button,
  Card,
  Checkbox,
  Field,
  FormSection,
  Input,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import {
  AGENT_TIERS,
  type Agent,
  type AgentSubagents,
  type AgentTemplateView,
  type AgentTier,
  type AgentVisibility,
  type InlineAgentTemplate,
  listAgents,
  listAgentTemplates,
  SUBAGENTS_INVALID_REASONS,
  type SubagentsInvalidReason,
} from "../lib/agents";
import { ApiClientError } from "../lib/api";
import { listMembers } from "../lib/members";

/** The builtin tool that dispatches sub-agents. */
export const AGENT_TOOL = "agent";

/** Limits of the kernel schema (`SubagentsSchema`). */
const INLINE_MAX = 10;
const AGENTS_MAX = 10;

type AllowedAgent = { agentId: string; as: string; description: string };

/** One `agent.subagents_invalid` detail, or a required field left empty (`required`). */
export interface SubagentsProblem {
  reason: SubagentsInvalidReason | "required";
  path: string;
  value?: string;
}

/** The `agent.subagents_invalid` details of an error, else empty. */
export function subagentsProblemsOf(e: unknown): SubagentsProblem[] {
  if (!(e instanceof ApiClientError) || e.code !== "agent.subagents_invalid") return [];
  return e.rawDetails.flatMap((d) => {
    if (typeof d !== "object" || d === null) return [];
    const { reason, path, value } = d as Record<string, unknown>;
    if (typeof path !== "string") return [];
    if (!(SUBAGENTS_INVALID_REASONS as readonly unknown[]).includes(reason)) return [];
    return [
      {
        reason: reason as SubagentsInvalidReason,
        path,
        ...(typeof value === "string" && { value }),
      },
    ];
  });
}

/**
 * Required fields left empty (the kernel schema's `min(1)`): the kernel answers a generic
 * `validation_failed` for them, so they are marked here when a save fails that way.
 */
export function missingRequired(
  inline: InlineAgentTemplate[],
  agents: AllowedAgent[],
): SubagentsProblem[] {
  const out: SubagentsProblem[] = [];
  inline.forEach((x, i) => {
    for (const f of ["name", "description", "instructions"] as const) {
      if (x[f].trim() === "") out.push({ reason: "required", path: `subagents.inline.${i}.${f}` });
    }
  });
  agents.forEach((x, i) => {
    for (const f of ["as", "description"] as const) {
      if (x[f].trim() === "") out.push({ reason: "required", path: `subagents.agents.${i}.${f}` });
    }
  });
  return out;
}

/** Who can see an agent, narrowest first (the "shared more widely" warning compares these). */
const REACH: Record<AgentVisibility, number> = { private: 0, members: 1, org: 2 };

/** JSON with object keys sorted (the kernel stores definitions as jsonb, which reorders keys). */
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : typeof v === "object" && v !== null
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

/** Equal as saved, whatever the key order. */
const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** An inline template as saved: its fields without empty optional values. */
function cleanInline(x: InlineAgentTemplate): InlineAgentTemplate {
  const { model, ...rest } = x;
  return { ...rest, ...(model !== undefined && { model }) };
}

/**
 * The `subagents` block to save: keys the person set, or that the definition had (kept even when
 * emptied, as for `skills.pinned`); undefined when there is nothing and there was nothing, so an
 * agent without sub-agents gains no version. Unknown keys of a newer kernel are kept.
 */
function buildSubagents(
  initial: AgentSubagents | undefined,
  s: {
    general: boolean;
    templates: string[];
    inline: InlineAgentTemplate[];
    agents: AllowedAgent[];
    dispatchable: boolean;
  },
): AgentSubagents | undefined {
  const had = (k: keyof AgentSubagents) => initial !== undefined && k in initial;
  const out: AgentSubagents & Record<string, unknown> = { ...(initial ?? {}) };
  if (!s.general) out.general = false;
  else if (had("general")) out.general = true;
  else delete out.general;
  const lists: Record<"templates" | "inline" | "agents", unknown[]> = {
    templates: s.templates,
    inline: s.inline.map(cleanInline),
    agents: s.agents,
  };
  for (const k of ["templates", "inline", "agents"] as const) {
    if (lists[k].length > 0 || had(k)) (out as Record<string, unknown>)[k] = lists[k];
    else delete out[k];
  }
  if (s.dispatchable) out.dispatchable = true;
  else if (had("dispatchable")) out.dispatchable = false;
  else delete out.dispatchable;
  if (initial === undefined && Object.keys(out).length === 0) return undefined;
  return out;
}

/** What {@link useSubagentsForm} gives the agent form. */
export interface SubagentsForm {
  /** The FormSection. */
  section: ReactNode;
  /** The `subagents` block to save (undefined: leave it out). */
  value: AgentSubagents | undefined;
  /** Whether the `agent` builtin tool is on. */
  agentTool: boolean;
  /** Changes against the definition being edited (for the ActionRow). */
  unsaved: number;
  /** Problems from the last save (for the ActionRow error count). */
  errors: number;
  /** Shows a refused save's `agent.subagents_invalid` reasons next to their fields. */
  showProblems(e: unknown): void;
}

/**
 * The agent page's "Sub-agents" section (phase C, spec §5.2, §5.5, §17): the `agent` tool,
 * general-purpose, plugin agent templates (from `GET .../agent-templates`), inline templates, the
 * org agents this agent may dispatch (only dispatchable ones other than itself; the allowlist warns
 * that their names and descriptions are shown to everyone using this agent, that their skill files
 * stay in the conversation's sandbox, and when this agent is shared more widely than the chosen
 * one), and the switch that lets other agents dispatch this one. Lists that cannot be read are
 * left empty; the kernel checks every selection on save.
 */
export function useSubagentsForm(
  orgId: string,
  existing: Agent | undefined,
  visibility: AgentVisibility,
): SubagentsForm {
  const t = useTranslations("agents.form.subagents");
  const initial = existing?.definition.subagents;
  const [initialTool] = useState(
    () =>
      existing?.definition.tools?.some((r) => r.kind === "builtin" && r.name === AGENT_TOOL) ??
      false,
  );
  const [agentTool, setAgentTool] = useState(initialTool);
  const [general, setGeneral] = useState(initial?.general !== false);
  const [templates, setTemplates] = useState<string[]>(initial?.templates ?? []);
  const [inline, setInline] = useState<InlineAgentTemplate[]>(initial?.inline ?? []);
  const [agents, setAgents] = useState<AllowedAgent[]>(initial?.agents ?? []);
  const [dispatchable, setDispatchable] = useState(initial?.dispatchable === true);
  const [problems, setProblems] = useState<SubagentsProblem[]>([]);
  const [templateList, setTemplateList] = useState<AgentTemplateView[]>([]);
  const [orgAgents, setOrgAgents] = useState<Agent[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let disposed = false;
    listAgentTemplates(orgId).then(
      (r) => {
        if (!disposed) setTemplateList(r.templates);
      },
      () => {},
    );
    listAgents(orgId).then(
      (r) => {
        if (!disposed) setOrgAgents(r.agents);
      },
      () => {},
    );
    listMembers(orgId).then(
      (r) => {
        if (!disposed) {
          setNames(Object.fromEntries(r.members.map((m) => [m.account.id, m.account.displayName])));
        }
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [orgId]);

  const value = buildSubagents(initial, {
    general,
    templates,
    inline,
    agents,
    dispatchable,
  });
  const unsaved = (agentTool !== initialTool ? 1 : 0) + (sameJson(value, initial) ? 0 : 1);

  const problemText = (p: SubagentsProblem) => t(`reasons.${p.reason}`, { value: p.value ?? "" });
  const problemsAt = (prefix: string) =>
    problems.filter((p) => p.path === prefix || p.path.startsWith(`${prefix}.`));
  const errorAt = (prefix: string): string | undefined => {
    const list = problemsAt(prefix);
    return list.length === 0 ? undefined : list.map(problemText).join(" ");
  };
  /** `{ error }` for a Field when a problem is at `path`, else nothing. */
  const fieldError = (path: string): { error?: string } => {
    const e = errorAt(path);
    return e === undefined ? {} : { error: e };
  };
  const listProblems = (prefix: string) =>
    problemsAt(prefix).map((p) => (
      <Text key={`${p.path}:${p.reason}`} variant="small" tone="fail">
        {problemText(p)}
      </Text>
    ));

  const hasSettings = value !== undefined && Object.keys(value).some((k) => k !== "dispatchable");
  const tierLabel = (tier: AgentTier) => t(`tier.${tier}`);
  const candidates = orgAgents.filter(
    (a) =>
      a.id !== existing?.id &&
      (a.definition.subagents?.dispatchable === true || agents.some((x) => x.agentId === a.id)),
  );
  // allowlisted agents the editor can no longer see (kept as they are)
  const unseen = agents.filter((x) => !candidates.some((a) => a.id === x.agentId));

  /**
   * Is this agent shared with people who cannot use `a`? A wider visibility, or (both `members`)
   * a member of this agent missing from `a`'s list (unknown lists give no warning).
   */
  const sharedWider = (a: Agent): boolean => {
    if (REACH[visibility] > REACH[a.visibility]) return true;
    if (visibility !== "members" || a.visibility !== "members") return false;
    const mine = existing?.visibility === "members" ? existing.memberIds : undefined;
    const theirs = a.memberIds;
    if (!mine || !theirs) return false;
    return mine.some((id) => id !== a.ownerAccountId && !theirs.includes(id));
  };
  const updateInline = (i: number, patch: Partial<InlineAgentTemplate>) =>
    setInline((cur) => cur.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const updateAgent = (agentId: string, patch: Partial<AllowedAgent>) =>
    setAgents((cur) => cur.map((x) => (x.agentId === agentId ? { ...x, ...patch } : x)));

  const section = (
    <FormSection id="subagents" title={t("section")} description={t("sectionHint")}>
      <Checkbox label={t("agentTool")} checked={agentTool} onChange={setAgentTool} />
      {!agentTool && hasSettings && (
        <Text variant="small" tone="warn" icon="circle-alert">
          {t("unused")}
        </Text>
      )}
      {problems
        .filter((p) => !/^subagents\.(templates|inline|agents)\./.test(p.path))
        .map((p) => (
          <Text key={`${p.path}:${p.reason}`} variant="small" tone="fail">
            {problemText(p)}
          </Text>
        ))}
      {(agentTool || hasSettings) && (
        <Stack gap={16}>
          <Checkbox label={t("general")} checked={general} onChange={setGeneral} />
          {/* biome-ignore lint/a11y/useSemanticElements: fieldset has browser default styles; apps/web writes none */}
          <div role="group" aria-label={t("templatesLabel")}>
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("templatesLabel")}
              </Text>
              {templateList.length === 0 && templates.length === 0 && (
                <Text variant="small" tone="faint">
                  {t("templatesNone")}
                </Text>
              )}
              {templateList.map((tpl) => (
                <Checkbox
                  key={tpl.id}
                  checked={templates.includes(tpl.id)}
                  onChange={(on) =>
                    setTemplates((cur) =>
                      on ? [...cur, tpl.id] : cur.filter((id) => id !== tpl.id),
                    )
                  }
                  label={
                    <Stack gap={0}>
                      <Text>{`${tpl.type} · ${tierLabel(tpl.model)}`}</Text>
                      <Text variant="small" tone="muted">
                        {tpl.description}
                      </Text>
                    </Stack>
                  }
                />
              ))}
              {templates
                .filter((id) => !templateList.some((x) => x.id === id))
                .map((id) => (
                  <Checkbox
                    key={id}
                    checked
                    onChange={() => setTemplates((cur) => cur.filter((x) => x !== id))}
                    label={t("templateGone", { id })}
                  />
                ))}
              {listProblems("subagents.templates")}
            </Stack>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: fieldset has browser default styles; apps/web writes none */}
          <div role="group" aria-label={t("inlineLabel")}>
            <Stack gap={8}>
              <Text variant="small" tone="muted">
                {t("inlineLabel")}
              </Text>
              {inline.map((x, i) => (
                <Card
                  // biome-ignore lint/suspicious/noArrayIndexKey: drafts have no id; order is the roster order
                  key={i}
                  title={x.name || t("inlineNew")}
                  actions={
                    <Button
                      variant="ghost"
                      density="dense"
                      aria-label={t("removeInline", { name: x.name || t("inlineNew") })}
                      onClick={() => setInline((cur) => cur.filter((_, j) => j !== i))}
                    >
                      {t("remove")}
                    </Button>
                  }
                >
                  <Stack gap={8}>
                    <Field
                      label={t("inlineName")}
                      help={t("inlineNameHelp")}
                      {...fieldError(`subagents.inline.${i}.name`)}
                    >
                      <Input
                        value={x.name}
                        maxLength={64}
                        onChange={(e) => updateInline(i, { name: e.target.value })}
                      />
                    </Field>
                    <Field
                      label={t("inlineDescription")}
                      {...fieldError(`subagents.inline.${i}.description`)}
                    >
                      <Textarea
                        rows={2}
                        maxLength={4096}
                        value={x.description}
                        onChange={(e) => updateInline(i, { description: e.target.value })}
                      />
                    </Field>
                    <Field
                      label={t("inlineInstructions")}
                      {...fieldError(`subagents.inline.${i}.instructions`)}
                    >
                      <Textarea
                        code
                        rows={4}
                        maxLength={100_000}
                        value={x.instructions}
                        onChange={(e) => updateInline(i, { instructions: e.target.value })}
                      />
                    </Field>
                    <Field label={t("inlineModel")}>
                      <Select
                        value={x.model ?? "inherit"}
                        onChange={(e) => {
                          const v = e.target.value as AgentTier;
                          setInline((cur) =>
                            cur.map((y, k) => {
                              if (k !== i) return y;
                              const { model: _old, ...rest } = y;
                              return v === "inherit" ? rest : { ...rest, model: v };
                            }),
                          );
                        }}
                        options={AGENT_TIERS.map((tier) => ({
                          value: tier,
                          label: tierLabel(tier),
                        }))}
                      />
                    </Field>
                    {problemsAt(`subagents.inline.${i}`)
                      .filter(
                        (p) =>
                          !["name", "description", "instructions"].some(
                            (f) => p.path === `subagents.inline.${i}.${f}`,
                          ),
                      )
                      .map((p) => (
                        <Text key={`${p.path}:${p.reason}`} variant="small" tone="fail">
                          {problemText(p)}
                        </Text>
                      ))}
                  </Stack>
                </Card>
              ))}
              <Stack direction="row" gap={8}>
                <Button
                  disabled={inline.length >= INLINE_MAX}
                  onClick={() =>
                    setInline((cur) => [...cur, { name: "", description: "", instructions: "" }])
                  }
                >
                  {t("addInline")}
                </Button>
              </Stack>
            </Stack>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: fieldset has browser default styles; apps/web writes none */}
          <div role="group" aria-label={t("agentsLabel")}>
            <Stack gap={8}>
              <Text variant="small" tone="muted">
                {t("agentsLabel")}
              </Text>
              {candidates.length === 0 && unseen.length === 0 ? (
                <Text variant="small" tone="faint">
                  {t("agentsNone")}
                </Text>
              ) : (
                <Text variant="small" tone="warn" icon="circle-alert">
                  {t("agentsWarning")}
                </Text>
              )}
              {candidates.map((a) => {
                const chosen = agents.find((x) => x.agentId === a.id);
                const index = agents.findIndex((x) => x.agentId === a.id);
                const name = a.definition.name;
                const owner = names[a.ownerAccountId] ?? a.ownerAccountId;
                return (
                  <Stack key={a.id} gap={4}>
                    <Checkbox
                      checked={chosen !== undefined}
                      disabled={chosen === undefined && agents.length >= AGENTS_MAX}
                      onChange={(on) =>
                        setAgents((cur) =>
                          on
                            ? [...cur, { agentId: a.id, as: "", description: "" }]
                            : cur.filter((x) => x.agentId !== a.id),
                        )
                      }
                      label={t("agentOption", {
                        name,
                        owner,
                        visibility: t(`visibility.${a.visibility}`),
                      })}
                    />
                    {chosen !== undefined && (
                      <Stack gap={8}>
                        {sharedWider(a) && (
                          <Text variant="small" tone="warn">
                            {t("widerWarning", { name })}
                          </Text>
                        )}
                        <Field
                          label={t("agentAs", { name })}
                          help={t("inlineNameHelp")}
                          {...fieldError(`subagents.agents.${index}.as`)}
                        >
                          <Input
                            value={chosen.as}
                            maxLength={64}
                            onChange={(e) => updateAgent(a.id, { as: e.target.value })}
                          />
                        </Field>
                        <Field
                          label={t("agentDescription", { name })}
                          {...fieldError(`subagents.agents.${index}.description`)}
                        >
                          <Textarea
                            rows={2}
                            maxLength={1024}
                            value={chosen.description}
                            onChange={(e) => updateAgent(a.id, { description: e.target.value })}
                          />
                        </Field>
                        {problemsAt(`subagents.agents.${index}`)
                          .filter(
                            (p) =>
                              p.path !== `subagents.agents.${index}.as` &&
                              p.path !== `subagents.agents.${index}.description`,
                          )
                          .map((p) => (
                            <Text key={`${p.path}:${p.reason}`} variant="small" tone="fail">
                              {problemText(p)}
                            </Text>
                          ))}
                      </Stack>
                    )}
                  </Stack>
                );
              })}
              {unseen.map((x) => {
                const index = agents.findIndex((y) => y.agentId === x.agentId);
                return (
                  <Stack key={x.agentId} gap={4}>
                    <Checkbox
                      checked
                      onChange={() =>
                        setAgents((cur) => cur.filter((y) => y.agentId !== x.agentId))
                      }
                      label={t("agentUnseen", { as: x.as, id: x.agentId })}
                    />
                    {listProblems(`subagents.agents.${index}`)}
                  </Stack>
                );
              })}
            </Stack>
          </div>
        </Stack>
      )}
      <Stack direction="row" gap={8} align="center">
        <Switch label={t("dispatchable")} checked={dispatchable} onChange={setDispatchable} />
        <Stack gap={0}>
          <Text>{t("dispatchable")}</Text>
          <Text variant="small" tone="muted">
            {t("dispatchableHint")}
          </Text>
        </Stack>
      </Stack>
    </FormSection>
  );

  return {
    section,
    value,
    agentTool,
    unsaved,
    errors: problems.length,
    showProblems: (e) =>
      setProblems([
        ...subagentsProblemsOf(e),
        ...(e instanceof ApiClientError && e.code === "validation_failed"
          ? missingRequired(inline, agents)
          : []),
      ]),
  };
}
