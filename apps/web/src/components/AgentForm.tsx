"use client";

import {
  Card,
  Checkbox,
  Field,
  FormSection,
  Input,
  Select,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useQueries } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import {
  type Agent,
  type AgentDefinitionInput,
  type AgentToolRef,
  type AgentVisibility,
  type AgentWarning,
  BUILTIN_TOOLS,
  createAgent,
  DEFAULT_BUILTIN_TOOLS,
  findModel,
  keepDeclared,
  type ModelParameter,
  type ParamValue,
  type ProviderModels,
  type TightenedPolicy,
} from "../lib/agents";
import { ApiClientError } from "../lib/api";
import type { ConnectorDetail } from "../lib/connectors";
import { labelLocale, modelLabel } from "../lib/extension-label";
import { retryOnMountOf } from "../lib/query/client";
import { connectorQuery } from "../lib/query/conversation";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { PINNED_SKILLS_LIMITS, pinnedProblemsOf, type SkillSummary } from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";
import { OrgSkillsPicker, PinnedSkillsPicker, SkillWriteSwitch } from "./AgentSkills";
import { AGENT_TOOL, useSubagentsForm } from "./AgentSubagents";
import {
  BUILTIN_SET,
  decodeModel as decode,
  encodeModel as encode,
} from "./agent/definition-parts";
import type { AgentFormData } from "./agent/form-data";
import { FormError } from "./form-error";
import { ModelParams } from "./ModelParams";

const VISIBILITIES = ["private", "org"] as const satisfies readonly AgentVisibility[];

/** A new agent's starting values: the first model, the default builtin tools. */
function initialOf(providers: ProviderModels[]) {
  const first = providers.find((p) => p.models.length > 0);
  const firstModel = first?.models[0];
  return {
    model: first && firstModel ? encode({ provider: first.provider, model: firstModel.id }) : "",
    builtins: [...DEFAULT_BUILTIN_TOOLS],
  };
}

const NAME_MAX = 80;
/** 在这些单行输入框里按 Enter 即保存（表单没有原生提交按钮，含数字框时浏览器也不做隐式提交）。 */
const ENTER_SUBMITS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

type Params = Record<string, ParamValue>;
type ParamField = "modelParams" | "fallbackParams";
/** 参数字段的校验错误：键 → 文案。 */
type FieldErrors = Record<ParamField, Record<string, string>>;
const NO_FIELD_ERRORS: FieldErrors = { modelParams: {}, fallbackParams: {} };

/** What {@link useAgentForm} gives the page to put in FormPage (sections, ActionRow). */
export type AgentFormView = {
  /** 表单分组（FormSection），作为 FormPage 的 children。 */
  sections: ReactNode;
  /** ActionRow：未保存改动数与错误数。 */
  unsaved: number;
  errors: number;
  /** 保存成功但有警告：主操作改为「继续」（调用 onDone），不再重复创建。 */
  saved: boolean;
  /** The agent the last save returned (for "Continue" after warnings). */
  savedAgent?: Agent;
  submit(): void;
  pending: boolean;
  canSubmit: boolean;
  /** The last save failed (its error shows above the sections). */
  failed: boolean;
};

/**
 * The create form of `/agents/new` (an existing agent is edited by section on the agent page):
 * the model select comes from `GET /models`, the fallback is optional, and each has a params
 * section by the chosen model's declarations (a switch drops the keys the new model does not
 * declare). A save without warnings calls `onDone`; with warnings (such as
 * `fallback_same_provider`) they show in a danger card on top and "Continue" calls `onDone`.
 */
export function useAgentForm(
  orgId: string,
  onDone: (agent?: Agent) => void,
  data: AgentFormData,
): AgentFormView {
  const t = useTranslations("agents");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const errorMessage = useErrorMessage();
  const providers = data.providers;
  const [initial] = useState(() => initialOf(providers));
  // A save invalidates the agents list, the agent and the org's readiness (a first agent makes it
  // ready).
  const saveAgent = useAppMutation({
    fn: (input: { definition: AgentDefinitionInput; visibility: AgentVisibility }) =>
      createAgent(orgId, input),
    invalidates: (_, r) => [
      keys.org(orgId).agents(),
      keys.org(orgId).agent(r.agent.id),
      keys.org(orgId).readiness(),
    ],
  });
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [visibility, setVisibility] = useState<AgentVisibility>("private");
  const [model, setModel] = useState(initial.model);
  const [fallback, setFallback] = useState("");
  const [modelParams, setModelParams] = useState<Params>({});
  const [fallbackParams, setFallbackParams] = useState<Params>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [nameError, setNameError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const [otherErrors, setOtherErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<AgentWarning[]>();
  const [savedAgent, setSavedAgent] = useState<Agent>();
  const [builtins, setBuiltins] = useState<string[]>(initial.builtins);
  // The connectors on offer: the active ones (none when the list could not be read; the builtin
  // tools stay available).
  const apps = (data.connectors ?? []).filter((a) => a.status === "active");
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>([]);
  // Every connector selected since the form opened: their tools are read (cached), so a connector
  // switched off again still counts as managed when its policies are dropped on save.
  const [seenConnectors, setSeenConnectors] = useState<string[]>([]);
  // A connector's tools only serve to tighten policies: one that cannot be read just offers none.
  const details = useQueries({
    queries: seenConnectors.map((id) => {
      const q = connectorQuery(orgId, id);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  const connectorDetails: Record<string, ConnectorDetail> = Object.fromEntries(
    seenConnectors.flatMap((id, i) => {
      const d = details[i]?.data;
      return d === undefined ? [] : [[id, d]];
    }),
  );
  const [policies, setPolicies] = useState<Record<string, TightenedPolicy>>({});
  // The org skill library: empty and `failed` when it could not be read (the form still works).
  const orgList = { skills: data.orgSkills ?? [], failed: data.orgSkills === null };
  const orgSkills = orgList.skills;
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [confirmSkillWrite, setConfirmSkillWrite] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const subagents = useSubagentsForm(undefined, visibility, data.subagents);
  /** Every skill the form knows (a new agent has none of its own), for names and pinning. */
  const allSkills: SkillSummary[] = orgSkills;
  /** What the pinned picker may judge (stale pins): the library read, undefined otherwise. */
  const pinnable = orgList.failed ? undefined : allSkills;
  const nameOfSkill = (id: string) => allSkills.find((s) => s.id === id)?.name ?? id;

  /**
   * Selecting org skills: a newly selected skill its plugin suggests pinning is ticked as pinned
   * while there is room; a deselected one is unpinned.
   */
  function onOrgSkillsChange(next: string[]) {
    const added = next.filter((id) => !skillIds.includes(id));
    const removed = skillIds.filter((id) => !next.includes(id));
    setSkillIds(next);
    setPinned((cur) => {
      const kept = cur.filter((id) => !removed.includes(id));
      for (const id of added) {
        const s = orgSkills.find((x) => x.id === id);
        if (
          s?.suggestPinned === true &&
          !kept.includes(id) &&
          kept.length < PINNED_SKILLS_LIMITS.count
        )
          kept.push(id);
      }
      return kept;
    });
  }

  function toggleConnector(connectorId: string, on: boolean) {
    setSelectedConnectors((cur) =>
      on ? [...cur, connectorId] : cur.filter((id) => id !== connectorId),
    );
    if (on) setSeenConnectors((cur) => (cur.includes(connectorId) ? cur : [...cur, connectorId]));
  }

  /** 当前引用的工具 key（用于策略收紧）：内置工具名 + 已选连接器中启用的工具。 */
  const toolKeys = [
    ...builtins,
    ...selectedConnectors.flatMap((id) =>
      (connectorDetails[id]?.tools ?? []).filter((x) => x.status === "enabled").map((x) => x.key),
    ),
  ];

  /** 下拉框值对应模型的参数声明（未选或找不到时为空）。 */
  const declOf = (v: string): ModelParameter[] => {
    const ref = decode(v);
    return (ref && findModel(providers, ref)?.parameters) || [];
  };
  const modelDecl = declOf(model);
  const fallbackDecl = declOf(fallback);

  function onModelChange(v: string) {
    setModel(v);
    setModelParams((p) => keepDeclared(declOf(v), p));
    setFieldErrors((e) => ({ ...e, modelParams: {} }));
  }

  function onFallbackChange(v: string) {
    setFallback(v);
    // 没有兜底模型时 fallbackParams 必须为空（内核会拒绝）
    setFallbackParams((p) => (v === "" ? {} : keepDeclared(declOf(v), p)));
    setFieldErrors((e) => ({ ...e, fallbackParams: {} }));
  }

  /** 把 `validation_failed` 的 details 映射到参数字段；对不上界面字段的单独列出。 */
  function showDetails(err: unknown) {
    if (!(err instanceof ApiClientError) || err.code !== "validation_failed") return;
    const decl: Record<ParamField, ModelParameter[]> = {
      modelParams: modelDecl,
      fallbackParams: fallbackDecl,
    };
    const fields: FieldErrors = { modelParams: {}, fallbackParams: {} };
    const others: string[] = [];
    for (const d of err.details) {
      const dot = d.path.indexOf(".");
      if (dot < 0) continue;
      const field = d.path.slice(0, dot) as ParamField;
      const key = d.path.slice(dot + 1);
      if (!Object.hasOwn(fields, field)) continue;
      if (decl[field].some((p) => p.key === key)) fields[field][key] = t("params.invalid");
      else others.push(t("params.invalidKey", { key }));
    }
    setFieldErrors(fields);
    setOtherErrors(others);
  }

  const options = providers.flatMap((p) =>
    p.models.map((m) => ({
      value: encode({ provider: p.provider, model: m.id }),
      label: modelLabel(
        { name: p.provider, displayName: p.displayName },
        m.displayName || m.id,
        lang,
      ),
    })),
  );
  const noModels = options.length === 0;
  // The primary waits for a name (spec §5.3); Enter in the name field still says what is missing.
  const canSubmit = !pending && !noModels && name.trim() !== "";

  /** The tool references to create: the builtins, the `agent` tool and the whole connectors. */
  function toolRefs(): AgentToolRef[] {
    return [
      ...builtins.map((name) => ({ kind: "builtin" as const, name })),
      // the agent tool is switched in the Sub-agents section
      ...(subagents.agentTool ? [{ kind: "builtin" as const, name: AGENT_TOOL }] : []),
      ...selectedConnectors.map((connectorId) => ({
        kind: "connector" as const,
        connectorId,
        tools: "all" as const,
      })),
    ];
  }

  /** The policies to create: those of the tools the form references now. */
  function toolPolicies(): Record<string, TightenedPolicy> {
    const managed = (k: string) =>
      BUILTIN_SET.has(k) ||
      Object.values(connectorDetails).some((a) => a.tools.some((x) => x.key === k));
    return Object.fromEntries(
      Object.entries(policies).filter(([k]) => toolKeys.includes(k) || !managed(k)),
    );
  }

  async function save() {
    if (pending || noModels || warnings !== undefined) return;
    const trimmed = name.trim();
    setNameError(trimmed === "");
    if (trimmed === "") return;
    const main = decode(model);
    if (main === null) return;
    const fb = decode(fallback);
    const definition: AgentDefinitionInput = {
      name: trimmed,
      instructions,
      model: main,
      fallback: fb,
      modelParams,
      fallbackParams: fb === null ? {} : fallbackParams,
      tools: toolRefs(),
      toolPolicies: toolPolicies(),
    };
    // an agent without skills is created without a skills block
    if (skillIds.length > 0 || confirmSkillWrite || pinned.length > 0) {
      definition.skills = {
        orgSkills: skillIds,
        // pinned has no default: written only when something is pinned
        ...(pinned.length > 0 ? { pinned } : {}),
        // writePolicy: off is the default (allow), so only `ask` is written
        ...(confirmSkillWrite ? { writePolicy: "ask" as const } : {}),
      };
    }
    // no subagents block unless set
    if (subagents.value !== undefined) definition.subagents = subagents.value;
    setPending(true);
    setError(undefined);
    subagents.showProblems(undefined);
    setFieldErrors(NO_FIELD_ERRORS);
    setOtherErrors([]);
    try {
      const res = await saveAgent.mutateAsync({ definition, visibility });
      setSavedAgent(res.agent);
      if (res.warnings.length === 0) onDone(res.agent);
      else setWarnings(res.warnings);
    } catch (err) {
      setError(errorMessage(err));
      showDetails(err);
      subagents.showProblems(err);
      const pins = pinnedProblemsOf(err);
      if (pins.length > 0) {
        setOtherErrors(
          pins.map((p) =>
            t(`form.pinnedError.${p.reason}`, {
              name: nameOfSkill(p.skill),
              max:
                p.reason === "too_large"
                  ? PINNED_SKILLS_LIMITS.totalBytes
                  : PINNED_SKILLS_LIMITS.count,
              bytes: p.totalBytes ?? 0,
            }),
          ),
        );
      }
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void save();
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    const el = e.target;
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (!(el instanceof HTMLInputElement) || !ENTER_SUBMITS.has(el.type)) return;
    e.preventDefault();
    void save();
  }

  const paramErrors = {
    modelParams: Object.keys(fieldErrors.modelParams).length,
    fallbackParams: Object.keys(fieldErrors.fallbackParams).length,
  };
  const errors =
    (nameError ? 1 : 0) +
    paramErrors.modelParams +
    paramErrors.fallbackParams +
    otherErrors.length +
    subagents.errors;
  const unsaved =
    warnings !== undefined
      ? 0
      : [name.trim() !== "", instructions !== "", visibility !== "private", fallback !== ""].filter(
          Boolean,
        ).length +
        Object.keys(modelParams).length +
        Object.keys(fallbackParams).length +
        selectedConnectors.length +
        Object.keys(policies).length +
        skillIds.length +
        pinned.length +
        (visibility === "private" && confirmSkillWrite ? 1 : 0) +
        subagents.unsaved;

  const sections = (
    <form onSubmit={onSubmit} onKeyDown={onKeyDown} noValidate>
      <Stack gap={16}>
        {warnings !== undefined && (
          <Card tone="danger" title={t("form.warningsTitle")}>
            <Stack gap={4}>
              {warnings.map((w) => (
                <Text key={w} tone="warn" icon="circle-alert">
                  {t.has(`warnings.${w}`) ? t(`warnings.${w}`) : t("warnings.unknown", { code: w })}
                </Text>
              ))}
            </Stack>
          </Card>
        )}
        {error !== undefined && <FormError message={error} extra={otherErrors} />}
        <div>
          <FormSection
            id="basic"
            title={t("form.basicSection")}
            description={t("form.basicSectionHint")}
          >
            <Field
              label={t("form.nameLabel")}
              required
              count={{ value: name.length, max: NAME_MAX }}
              {...(nameError ? { error: t("form.nameRequired") } : {})}
            >
              <Input
                name="name"
                maxLength={NAME_MAX}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (e.target.value.trim() !== "") setNameError(false);
                }}
              />
            </Field>
            <Field label={t("form.instructionsLabel")} optional help={t("form.instructionsHelp")}>
              <Textarea
                code
                name="instructions"
                rows={6}
                maxLength={100_000}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </Field>
            <Field label={t("form.visibilityLabel")}>
              <Select
                name="visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as AgentVisibility)}
                options={VISIBILITIES.map((v) => ({ value: v, label: t(`form.visibility.${v}`) }))}
              />
            </Field>
          </FormSection>
          <FormSection
            id="model"
            title={t("form.modelSection")}
            description={t("form.modelSectionHint")}
          >
            <Field
              label={t("form.modelLabel")}
              required
              {...(noModels ? { error: t("form.noModels") } : {})}
            >
              <Select
                name="model"
                disabled={noModels}
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                options={options}
              />
            </Field>
            <Field label={t("form.fallbackLabel")} optional>
              <Select
                name="fallback"
                value={fallback}
                onChange={(e) => onFallbackChange(e.target.value)}
                options={[{ value: "", label: t("form.fallbackNone") }, ...options]}
              />
            </Field>
          </FormSection>
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
                    checked={builtins.includes(name)}
                    onChange={(on) =>
                      setBuiltins((cur) => (on ? [...cur, name] : cur.filter((x) => x !== name)))
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
                    checked={selectedConnectors.includes(a.id)}
                    onChange={(on) => toggleConnector(a.id, on)}
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
                        value={policies[key] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value as TightenedPolicy | "";
                          setPolicies((cur) => {
                            const next = { ...cur };
                            if (v === "") delete next[key];
                            else next[key] = v;
                            return next;
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
          <FormSection
            id="skills"
            title={t("form.skillsSection")}
            description={t("form.skillsSectionHint")}
          >
            <OrgSkillsPicker skills={orgSkills} value={skillIds} onChange={onOrgSkillsChange} />
            <PinnedSkillsPicker
              skills={pinnable}
              selected={skillIds}
              value={pinned}
              onChange={setPinned}
              changed={pinned.length > 0}
            />
            {visibility === "private" && (
              <SkillWriteSwitch value={confirmSkillWrite} onChange={setConfirmSkillWrite} />
            )}
          </FormSection>
          {subagents.section}
          {modelDecl.length > 0 && (
            <FormSection
              id="params"
              title={t("form.modelParamsTitle")}
              description={t("form.paramsSectionHint")}
            >
              <ModelParams
                parameters={modelDecl}
                value={modelParams}
                onChange={setModelParams}
                locale={locale}
                errors={fieldErrors.modelParams}
              />
            </FormSection>
          )}
          {fallbackDecl.length > 0 && (
            <FormSection
              id="fallback-params"
              title={t("form.fallbackParamsTitle")}
              description={t("form.paramsSectionHint")}
            >
              <ModelParams
                parameters={fallbackDecl}
                value={fallbackParams}
                onChange={setFallbackParams}
                locale={locale}
                errors={fieldErrors.fallbackParams}
              />
            </FormSection>
          )}
        </div>
      </Stack>
    </form>
  );

  return {
    sections,
    unsaved,
    errors,
    saved: warnings !== undefined,
    ...(savedAgent ? { savedAgent } : {}),
    submit: () => void save(),
    pending,
    canSubmit,
    failed: error !== undefined,
  };
}

/**
 * The create form while its reads are on the way: its static sections (basics, model, tools,
 * skills, sub-agents), each with its field layout. The checkbox groups (tools, skills,
 * sub-agents) are counted as one field each.
 */
export function AgentFormLoading() {
  const t = useTranslations("agents");
  return (
    <Stack gap={16}>
      <div>
        <FormSection
          id="basic"
          title={t("form.basicSection")}
          description={t("form.basicSectionHint")}
          loading={{
            fields: [
              { control: "input" },
              { control: "textarea", rows: 6, help: true },
              { control: "select" },
            ],
          }}
        />
        <FormSection
          id="model"
          title={t("form.modelSection")}
          description={t("form.modelSectionHint")}
          loading={{ fields: [{ control: "select" }, { control: "select" }] }}
        />
        <FormSection
          id="tools"
          title={t("form.toolsSection")}
          description={t("form.toolsSectionHint")}
          loading={{ fields: 2 }}
        />
        <FormSection
          id="skills"
          title={t("form.skillsSection")}
          description={t("form.skillsSectionHint")}
          loading={{ fields: 2 }}
        />
        <FormSection
          id="subagents"
          title={t("form.subagents.section")}
          description={t("form.subagents.sectionHint")}
          loading={{ fields: 1 }}
        />
      </div>
    </Stack>
  );
}
