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
import { type UseQueryResult, useQueries, useQuery } from "@tanstack/react-query";
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
  updateAgent,
} from "../lib/agents";
import { ApiClientError } from "../lib/api";
import type { ConnectorDetail, ConnectorSummary } from "../lib/connectors";
import type { ModelRef } from "../lib/conversations";
import { labelLocale, modelLabel } from "../lib/extension-label";
import { agentSkillsQuery, agentsQuery, agentTemplatesQuery } from "../lib/query/agents";
import { retryOnMountOf } from "../lib/query/client";
import { connectorQuery, connectorsQuery, modelsQuery } from "../lib/query/conversation";
import { keys } from "../lib/query/keys";
import { membersQuery } from "../lib/query/members";
import { useAppMutation } from "../lib/query/mutation";
import { skillsQuery } from "../lib/query/skills";
import { PINNED_SKILLS_LIMITS, pinnedProblemsOf, type SkillSummary } from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";
import { OrgSkillsPicker, OwnSkills, PinnedSkillsPicker, SkillWriteSwitch } from "./AgentSkills";
import { AGENT_TOOL, type SubagentsFormData, useSubagentsForm } from "./AgentSubagents";
import { FormError } from "./form-error";
import { ModelParams } from "./ModelParams";
import { useSession } from "./shell/session";

const VISIBILITIES = ["private", "org"] as const satisfies readonly AgentVisibility[];
const BUILTIN_SET = new Set<string>(BUILTIN_TOOLS);

/** 修改时表单管不到的工具引用（插件工具、按名单选的连接器工具、界面不列的内置工具）：原样保留。 */
const isFormTool = (r: AgentToolRef) =>
  (r.kind === "builtin" && (BUILTIN_SET.has(r.name) || r.name === AGENT_TOOL)) ||
  (r.kind === "connector" && r.tools === "all");

/**
 * What the agent form shows, from its queries (`agentFormQueries` in `lib/query/agents.ts`). A
 * `null` list could not be read (the kernel refused or failed it): that part shows its own empty or
 * unavailable state.
 */
export interface AgentFormData {
  providers: ProviderModels[];
  connectors: ConnectorSummary[] | null;
  orgSkills: SkillSummary[] | null;
  /** The agent's own skills (`[]` for a new agent). */
  ownSkills: SkillSummary[] | null;
  subagents: SubagentsFormData;
}

/** The agent form's data as a page draws it. */
export type AgentFormState =
  | { kind: "loading" }
  | { kind: "ready"; data: AgentFormData }
  | { kind: "error"; code: string; retry(): void };

/** A read the form needs (the models): any failure fails the page. */
const REQUIRED = "required";
/** A read the role decides (connectors, org skills, members): a 403 / 404 leaves the part out. */
const OPTIONAL = "optional";
/** A section (templates, org agents, own skills): any failure is that part's own state. */
const SECTION = "section";

/**
 * The agent form's reads from the query cache (new agent, or `agentId` to edit), as one state:
 * `loading` until every read answered, `error` when a required read failed (or an optional one
 * failed otherwise than 403 / 404), else the data with `null` for the parts that could not be read.
 * An error the server already read is not read again on mount; `retry` reads the failed ones.
 */
export function useAgentFormData(orgId: string, agentId?: string): AgentFormState {
  const modelsQ = modelsQuery(orgId);
  const connectorsQ = connectorsQuery(orgId);
  const skillsQ = skillsQuery(orgId);
  const templatesQ = agentTemplatesQuery(orgId);
  const agentsQ = agentsQuery(orgId);
  const membersQ = membersQuery(orgId);
  // A query of no agent is disabled; the key's agent id is then never read.
  const ownQ = agentSkillsQuery(orgId, agentId ?? "");
  const models = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) });
  const connectors = useQuery({
    ...connectorsQ,
    retryOnMount: retryOnMountOf(connectorsQ.queryKey),
  });
  const skills = useQuery({ ...skillsQ, retryOnMount: retryOnMountOf(skillsQ.queryKey) });
  const templates = useQuery({ ...templatesQ, retryOnMount: retryOnMountOf(templatesQ.queryKey) });
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) });
  const members = useQuery({ ...membersQ, retryOnMount: retryOnMountOf(membersQ.queryKey) });
  const own = useQuery({
    ...ownQ,
    retryOnMount: retryOnMountOf(ownQ.queryKey),
    enabled: agentId !== undefined,
  });
  const all: [UseQueryResult<unknown, ApiClientError>, string][] = [
    [models, REQUIRED],
    [connectors, OPTIONAL],
    [skills, OPTIONAL],
    [members, OPTIONAL],
    [templates, SECTION],
    [agents, SECTION],
    ...(agentId === undefined ? [] : ([[own, SECTION]] as [typeof own, string][])),
  ];
  if (all.some(([q]) => q.data === undefined && q.error === null)) return { kind: "loading" };
  const fatal = all.find(
    ([q, kind]) =>
      q.data === undefined &&
      q.error !== null &&
      (kind === REQUIRED ||
        (kind === OPTIONAL && q.error.status !== 403 && q.error.status !== 404)),
  );
  if (fatal?.[0].error) {
    return {
      kind: "error",
      code: fatal[0].error.code,
      retry: () => {
        for (const [q] of all) if (q.error !== null) void q.refetch();
      },
    };
  }
  return {
    kind: "ready",
    data: {
      providers: models.data?.providers ?? [],
      connectors: connectors.data?.connectors ?? null,
      orgSkills: skills.data?.skills ?? null,
      ownSkills: agentId === undefined ? [] : (own.data?.skills ?? null),
      subagents: {
        templates: templates.data?.templates ?? null,
        agents: agents.data?.agents ?? null,
        members: members.data?.members ?? null,
      },
    },
  };
}

/** 由已有定义得到表单的初始值；新建时为默认值（主模型默认为第一个模型）。 */
function initialOf(existing: Agent | undefined, providers: ProviderModels[]) {
  const d = existing?.definition;
  const first = providers.find((p) => p.models.length > 0);
  const firstModel = first?.models[0];
  const tools = d?.tools ?? [];
  return {
    name: d?.name ?? "",
    instructions: d?.instructions ?? "",
    visibility: existing?.visibility ?? ("private" as AgentVisibility),
    model: d
      ? encode(d.model)
      : first && firstModel
        ? encode({ provider: first.provider, model: firstModel.id })
        : "",
    fallback: d?.fallback ? encode(d.fallback) : "",
    modelParams: { ...(d?.modelParams ?? {}) } as Params,
    fallbackParams: { ...(d?.fallbackParams ?? {}) } as Params,
    builtins: d
      ? tools.flatMap((r) => (r.kind === "builtin" && BUILTIN_SET.has(r.name) ? [r.name] : []))
      : [...DEFAULT_BUILTIN_TOOLS],
    apps: tools.flatMap((r) =>
      r.kind === "connector" && r.tools === "all" ? [r.connectorId] : [],
    ),
    extraTools: tools.filter((r) => !isFormTool(r)),
    policies: { ...(d?.toolPolicies ?? {}) } as Record<string, TightenedPolicy>,
    orgSkills: [...(d?.skills?.orgSkills ?? [])],
    pinned: [...(d?.skills?.pinned ?? [])],
    confirmSkillWrite: d?.skills?.writePolicy === "ask",
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const NAME_MAX = 80;
/** 在这些单行输入框里按 Enter 即保存（表单没有原生提交按钮，含数字框时浏览器也不做隐式提交）。 */
const ENTER_SUBMITS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

type Params = Record<string, ParamValue>;
type ParamField = "modelParams" | "fallbackParams";
/** 参数字段的校验错误：键 → 文案。 */
type FieldErrors = Record<ParamField, Record<string, string>>;
const NO_FIELD_ERRORS: FieldErrors = { modelParams: {}, fallbackParams: {} };

/** 下拉框的值：`provider/model`（供应商插件名不含 `/`，模型 id 可能含）。 */
const encode = (r: ModelRef) => `${r.provider}/${r.model}`;
function decode(v: string): ModelRef | null {
  const i = v.indexOf("/");
  return i <= 0 ? null : { provider: v.slice(0, i), model: v.slice(i + 1) };
}

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
};

/**
 * 新建 / 修改 agent 的表单状态与分组（给 `existing` 即修改：按其定义预填，保存发 PATCH，定义里表单不认识的
 * 字段与工具引用原样带回）：模型下拉框来自 `GET /models`，兜底模型可选；主模型与兜底模型
 * 各有一个参数分组，按所选模型的声明渲染（换模型时丢弃新模型没有声明的键）。保存成功且没有
 * 警告时调用 `onDone`；有警告（如 `fallback_same_provider`）时在表单顶部以 danger 卡片列出，
 * 由用户点「继续」再调用 `onDone`。
 */
export function useAgentForm(
  orgId: string,
  onDone: (agent?: Agent) => void,
  data: AgentFormData,
  existing?: Agent,
): AgentFormView {
  const t = useTranslations("agents");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const providers = data.providers;
  const [initial] = useState(() => initialOf(existing, providers));
  // The version the form was opened on: a save over someone else's newer one is a 409 conflict,
  // even when the agent's query was read again meanwhile.
  const [baseVersion] = useState(existing?.currentVersion);
  // A save invalidates the agents list, the agent and the org's readiness (a first agent makes it
  // ready).
  const saveAgent = useAppMutation({
    fn: (input: { definition: AgentDefinitionInput; visibility: AgentVisibility }) =>
      existing
        ? updateAgent(orgId, existing.id, {
            definition: input.definition,
            expectedVersion: baseVersion ?? existing.currentVersion,
            ...(input.visibility !== existing.visibility ? { visibility: input.visibility } : {}),
          })
        : createAgent(orgId, input),
    invalidates: (_, r) => [
      keys.org(orgId).agents(),
      keys.org(orgId).agent(r.agent.id),
      keys.org(orgId).readiness(),
    ],
  });
  const [name, setName] = useState(initial.name);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [visibility, setVisibility] = useState<AgentVisibility>(initial.visibility);
  const [model, setModel] = useState(initial.model);
  const [fallback, setFallback] = useState(initial.fallback);
  const [modelParams, setModelParams] = useState<Params>(initial.modelParams);
  const [fallbackParams, setFallbackParams] = useState<Params>(initial.fallbackParams);
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
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>(initial.apps);
  // Every connector selected since the form opened: their tools are read (cached), so a connector
  // switched off again still counts as managed when its policies are dropped on save.
  const [seenConnectors, setSeenConnectors] = useState<string[]>(initial.apps);
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
  const [policies, setPolicies] = useState<Record<string, TightenedPolicy>>(initial.policies);
  // The org skill library: empty and `failed` when it could not be read (the form still works).
  const orgList = { skills: data.orgSkills ?? [], failed: data.orgSkills === null };
  const orgSkills = orgList.skills;
  const [skillIds, setSkillIds] = useState<string[]>(initial.orgSkills);
  const [confirmSkillWrite, setConfirmSkillWrite] = useState(initial.confirmSkillWrite);
  // The agent's own skills, read again after a delete (the delete invalidates them).
  const own = { skills: data.ownSkills ?? [], failed: data.ownSkills === null };
  const [pinned, setPinned] = useState<string[]>(initial.pinned);
  const subagents = useSubagentsForm(existing, visibility, data.subagents);
  /** Every skill the form knows (org library and the agent's own), for names and pinning. */
  const allSkills: SkillSummary[] = [...orgSkills, ...own.skills];
  /** What the pinned picker may judge (stale pins): both lists read, undefined otherwise. */
  const pinnable = orgList.failed || own.failed ? undefined : allSkills;
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

  /**
   * 保存的工具引用：表单里的内置工具与连接器，加上修改时原样保留的其他引用。修改时按原定义的顺序保留仍选着的
   * 引用、新加的排在后面——没改动的保存与原定义完全相同，不产生新版本。
   */
  function toolRefs(): AgentToolRef[] {
    const picked: AgentToolRef[] = [
      ...builtins.map((name) => ({ kind: "builtin" as const, name })),
      // the agent tool is switched in the Sub-agents section
      ...(subagents.agentTool ? [{ kind: "builtin" as const, name: AGENT_TOOL }] : []),
      ...selectedConnectors.map((connectorId) => ({
        kind: "connector" as const,
        connectorId,
        tools: "all" as const,
      })),
    ];
    if (!existing) return [...picked, ...initial.extraTools];
    // 与键顺序无关的身份：内置按名字、连接器按 id（表单只管这两种；其余引用总是保留，不参与比较）
    const keyOf = (r: AgentToolRef) =>
      r.kind === "builtin"
        ? `builtin:${r.name}`
        : r.kind === "connector"
          ? `app:${r.connectorId}:${r.tools === "all" ? "*" : r.tools.join(",")}`
          : `plugin:${r.plugin}:${r.name}`;
    const pickedKeys = new Set(picked.map(keyOf));
    const kept = (existing.definition.tools ?? []).filter(
      (r) => !isFormTool(r) || pickedKeys.has(keyOf(r)),
    );
    const keptKeys = new Set(kept.map(keyOf));
    return [...kept, ...picked.filter((r) => !keptKeys.has(keyOf(r)))];
  }

  /** 保存的策略：表单里当前引用的工具；修改时，表单管不到的工具（如保留的插件工具）的原有策略也带回。 */
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
      // 修改：先铺上原定义，表单不认识的字段原样带回
      ...(existing?.definition ?? {}),
      name: trimmed,
      instructions,
      model: main,
      fallback: fb,
      modelParams,
      fallbackParams: fb === null ? {} : fallbackParams,
      tools: toolRefs(),
      toolPolicies: toolPolicies(),
    };
    // 不用技能的定义不带 skills（保存前后不变、不多一个版本）；原来带了就照实保存（含清空）
    // 合并而不是整个替换：skills 里表单不认识的键原样带回
    if (
      skillIds.length > 0 ||
      confirmSkillWrite ||
      pinned.length > 0 ||
      existing?.definition.skills !== undefined
    ) {
      const skills = { ...(existing?.definition.skills ?? {}), orgSkills: skillIds };
      // pinned has no default: written only when something is pinned or it was set before
      if (pinned.length > 0 || existing?.definition.skills?.pinned !== undefined) {
        skills.pinned = pinned;
      }
      // writePolicy：只在开关被改动时写；关闭 = 去掉键（缺省即 allow，不写进定义）。
      // 开关只对私有 agent 显示，但值保留在定义里（改回私有时仍生效）
      if (confirmSkillWrite !== initial.confirmSkillWrite) {
        if (confirmSkillWrite) skills.writePolicy = "ask";
        else delete skills.writePolicy;
      }
      definition.skills = skills;
    }
    // no subagents block unless set or set before (no new version for agents without it)
    if (subagents.value !== undefined) definition.subagents = subagents.value;
    else delete definition.subagents;
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
      : existing
        ? [
            name.trim() !== initial.name,
            instructions !== initial.instructions,
            visibility !== initial.visibility,
            model !== initial.model,
            fallback !== initial.fallback,
            !sameJson(modelParams, initial.modelParams),
            !sameJson(fallbackParams, initial.fallbackParams),
            !sameJson([...builtins].sort(), [...initial.builtins].sort()),
            !sameJson([...selectedConnectors].sort(), [...initial.apps].sort()),
            !sameJson(policies, initial.policies),
            !sameJson(skillIds, initial.orgSkills),
            !sameJson(pinned, initial.pinned),
            // 开关只对私有 agent 显示：共享时不计入改动数
            visibility === "private" && confirmSkillWrite !== initial.confirmSkillWrite,
          ].filter(Boolean).length + subagents.unsaved
        : [
            name.trim() !== "",
            instructions !== "",
            visibility !== "private",
            fallback !== "",
          ].filter(Boolean).length +
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
                options={[
                  ...VISIBILITIES,
                  // 指定成员的可见范围只能经 API 设置：修改时保留这个选项
                  ...(initial.visibility === "members" ? (["members"] as const) : []),
                ].map((v) => ({ value: v, label: t(`form.visibility.${v}`) }))}
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
              selected={[...skillIds, ...own.skills.map((s) => s.id)]}
              value={pinned}
              onChange={setPinned}
              changed={!sameJson(pinned, initial.pinned)}
            />
            {visibility === "private" && (
              <SkillWriteSwitch value={confirmSkillWrite} onChange={setConfirmSkillWrite} />
            )}
            {existing && (
              <OwnSkills
                orgId={orgId}
                agentId={existing.id}
                skills={own.skills}
                canDelete={existing.ownerAccountId === me.account.id}
                onDeleted={(id) => setPinned((cur) => cur.filter((x) => x !== id))}
              />
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
  };
}

/**
 * The agent form while its reads are on the way: its static sections (basics, model, tools,
 * skills, sub-agents, and the agent's channels when editing), each with its field layout. The
 * checkbox groups (tools, skills, sub-agents, channels) are counted as one field each.
 */
export function AgentFormLoading({ channels = false }: { channels?: boolean }) {
  const t = useTranslations("agents");
  return (
    <>
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
      {channels ? (
        <FormSection
          id="channels"
          title={t("channels.title")}
          description={t("channels.hint")}
          loading={{ fields: 1 }}
        />
      ) : null}
    </>
  );
}
