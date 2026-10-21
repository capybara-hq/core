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
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
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
  listModels,
  type ModelParameter,
  type ParamValue,
  type ProviderModels,
  type TightenedPolicy,
  updateAgent,
} from "../lib/agents";
import { ApiClientError } from "../lib/api";
import { type AppDetail, type AppSummary, getApp, listApps } from "../lib/apps";
import type { ModelRef } from "../lib/conversations";
import { useErrorMessage } from "../lib/use-error-message";
import { OrgSkillsPicker, OwnSkills, useOrgSkills } from "./AgentSkills";
import { FormError } from "./form-error";
import { ModelParams } from "./ModelParams";
import { useSession } from "./shell/session";

const VISIBILITIES = ["private", "org"] as const satisfies readonly AgentVisibility[];
const BUILTIN_SET = new Set<string>(BUILTIN_TOOLS);

/** 修改时表单管不到的工具引用（插件工具、按名单选的应用工具、界面不列的内置工具）：原样保留。 */
const isFormTool = (r: AgentToolRef) =>
  (r.kind === "builtin" && BUILTIN_SET.has(r.name)) || (r.kind === "app" && r.tools === "all");

/** 由已有定义得到表单的初始值；新建时为默认值。 */
function initialOf(existing: Agent | undefined) {
  const d = existing?.definition;
  const tools = d?.tools ?? [];
  return {
    name: d?.name ?? "",
    instructions: d?.instructions ?? "",
    visibility: existing?.visibility ?? ("private" as AgentVisibility),
    model: d ? encode(d.model) : "",
    fallback: d?.fallback ? encode(d.fallback) : "",
    modelParams: { ...(d?.modelParams ?? {}) } as Params,
    fallbackParams: { ...(d?.fallbackParams ?? {}) } as Params,
    builtins: d
      ? tools.flatMap((r) => (r.kind === "builtin" && BUILTIN_SET.has(r.name) ? [r.name] : []))
      : [...DEFAULT_BUILTIN_TOOLS],
    apps: tools.flatMap((r) => (r.kind === "app" && r.tools === "all" ? [r.appId] : [])),
    extraTools: tools.filter((r) => !isFormTool(r)),
    policies: { ...(d?.toolPolicies ?? {}) } as Record<string, TightenedPolicy>,
    orgSkills: [...(d?.skills?.orgSkills ?? [])],
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

/** {@link useAgentForm} 的结果：页面把它们放进 FormPage（锚点、分组、ActionRow）。 */
export type AgentFormView = {
  anchors: { id: string; label: string; error?: boolean }[];
  /** 表单分组（FormSection），作为 FormPage 的 children。 */
  sections: ReactNode;
  /** ActionRow：未保存改动数与错误数。 */
  unsaved: number;
  errors: number;
  /** 保存成功但有警告：主操作改为「继续」（调用 onDone），不再重复创建。 */
  saved: boolean;
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
export function useAgentForm(orgId: string, onDone: () => void, existing?: Agent): AgentFormView {
  const t = useTranslations("agents");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const [initial] = useState(() => initialOf(existing));
  const [providers, setProviders] = useState<ProviderModels[]>();
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
  const [builtins, setBuiltins] = useState<string[]>(initial.builtins);
  const [apps, setApps] = useState<AppSummary[]>();
  const [selectedApps, setSelectedApps] = useState<string[]>(initial.apps);
  const [appDetails, setAppDetails] = useState<Record<string, AppDetail>>({});
  const [policies, setPolicies] = useState<Record<string, TightenedPolicy>>(initial.policies);
  const orgSkills = useOrgSkills(orgId);
  const [skillIds, setSkillIds] = useState<string[]>(initial.orgSkills);

  // 可选的应用（读不到时不提供应用工具，内置工具照常可选）
  useEffect(() => {
    let disposed = false;
    listApps(orgId).then(
      (r) => {
        if (!disposed) setApps(r.apps.filter((a) => a.status === "active"));
      },
      () => {
        if (!disposed) setApps([]);
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId]);

  // 应用的工具列表只用于收紧策略：读不到时只是不显示该应用的策略选项
  const loadAppDetail = (appId: string) =>
    getApp(orgId, appId).then(
      ({ app }) => setAppDetails((d) => ({ ...d, [appId]: app })),
      () => {},
    );

  // 修改时：已选应用的工具列表（策略选项要用）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开表单时读一次
  useEffect(() => {
    for (const id of initial.apps) void loadAppDetail(id);
  }, [orgId]);

  function toggleApp(appId: string, on: boolean) {
    setSelectedApps((cur) => (on ? [...cur, appId] : cur.filter((id) => id !== appId)));
    if (on && appDetails[appId] === undefined) void loadAppDetail(appId);
  }

  /** 当前引用的工具 key（用于策略收紧）：内置工具名 + 已选应用中启用的工具。 */
  const toolKeys = [
    ...builtins,
    ...selectedApps.flatMap((id) =>
      (appDetails[id]?.tools ?? []).filter((x) => x.status === "enabled").map((x) => x.key),
    ),
  ];

  useEffect(() => {
    let disposed = false;
    listModels(orgId).then(
      (r) => {
        if (disposed) return;
        setProviders(r.providers);
        // 与原生下拉框一致：默认选中第一个模型（修改时保留原模型）
        const first = r.providers.find((p) => p.models.length > 0);
        const m = first?.models[0];
        if (first && m) setModel((cur) => cur || encode({ provider: first.provider, model: m.id }));
      },
      (e: unknown) => {
        if (!disposed) setError(errorMessage(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, errorMessage]);

  /** 下拉框值对应模型的参数声明（未选或找不到时为空）。 */
  const declOf = (v: string): ModelParameter[] => {
    const ref = decode(v);
    return (ref && providers && findModel(providers, ref)?.parameters) || [];
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

  const options = (providers ?? []).flatMap((p) =>
    p.models.map((m) => ({
      value: encode({ provider: p.provider, model: m.id }),
      label: `${p.provider} / ${m.displayName || m.id}`,
    })),
  );
  const noModels = providers !== undefined && options.length === 0;
  const canSubmit = !pending && providers !== undefined && !noModels;

  /**
   * 保存的工具引用：表单里的内置工具与应用，加上修改时原样保留的其他引用。修改时按原定义的顺序保留仍选着的
   * 引用、新加的排在后面——没改动的保存与原定义完全相同，不产生新版本。
   */
  function toolRefs(): AgentToolRef[] {
    const picked: AgentToolRef[] = [
      ...builtins.map((name) => ({ kind: "builtin" as const, name })),
      ...selectedApps.map((appId) => ({ kind: "app" as const, appId, tools: "all" as const })),
    ];
    if (!existing) return [...picked, ...initial.extraTools];
    const keyOf = (r: AgentToolRef) => JSON.stringify(r);
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
      BUILTIN_SET.has(k) || Object.values(appDetails).some((a) => a.tools.some((x) => x.key === k));
    return Object.fromEntries(
      Object.entries(policies).filter(([k]) => toolKeys.includes(k) || !managed(k)),
    );
  }

  async function save() {
    if (!canSubmit || warnings !== undefined) return;
    const main = decode(model);
    if (main === null) return;
    const trimmed = name.trim();
    setNameError(trimmed === "");
    if (trimmed === "") return;
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
    if (skillIds.length > 0 || existing?.definition.skills !== undefined) {
      definition.skills = { ...(existing?.definition.skills ?? {}), orgSkills: skillIds };
    }
    setPending(true);
    setError(undefined);
    setFieldErrors(NO_FIELD_ERRORS);
    setOtherErrors([]);
    try {
      const res = existing
        ? await updateAgent(orgId, existing.id, {
            definition,
            expectedVersion: existing.currentVersion,
            ...(visibility !== existing.visibility ? { visibility } : {}),
          })
        : await createAgent(orgId, { definition, visibility });
      if (res.warnings.length === 0) onDone();
      else setWarnings(res.warnings);
    } catch (err) {
      setError(errorMessage(err));
      showDetails(err);
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
    (nameError ? 1 : 0) + paramErrors.modelParams + paramErrors.fallbackParams + otherErrors.length;
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
            !sameJson([...selectedApps].sort(), [...initial.apps].sort()),
            !sameJson(policies, initial.policies),
            !sameJson(skillIds, initial.orgSkills),
          ].filter(Boolean).length
        : [
            name.trim() !== "",
            instructions !== "",
            visibility !== "private",
            fallback !== "",
          ].filter(Boolean).length +
          Object.keys(modelParams).length +
          Object.keys(fallbackParams).length +
          selectedApps.length +
          Object.keys(policies).length +
          skillIds.length;

  const anchors: AgentFormView["anchors"] = [
    { id: "basic", label: t("form.basicSection"), error: nameError },
    { id: "model", label: t("form.modelSection"), error: noModels },
    { id: "tools", label: t("form.toolsSection") },
    { id: "skills", label: t("form.skillsSection") },
    ...(modelDecl.length > 0
      ? [{ id: "params", label: t("form.modelParamsTitle"), error: paramErrors.modelParams > 0 }]
      : []),
    ...(fallbackDecl.length > 0
      ? [
          {
            id: "fallback-params",
            label: t("form.fallbackParamsTitle"),
            error: paramErrors.fallbackParams > 0,
          },
        ]
      : []),
  ];

  const sections = (
    <form onSubmit={onSubmit} onKeyDown={onKeyDown} noValidate>
      <Stack gap={16}>
        {warnings !== undefined && (
          <Card tone="danger" title={t("form.warningsTitle")}>
            <Stack gap={4}>
              {warnings.map((w) => (
                <Text key={w} tone="warn">
                  {`‖ ${t.has(`warnings.${w}`) ? t(`warnings.${w}`) : t("warnings.unknown", { code: w })}`}
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
                disabled={providers === undefined}
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
            <div role="group" aria-label={t("form.appsLabel")}>
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {t("form.appsLabel")}
                </Text>
                {apps !== undefined && apps.length === 0 && (
                  <Text variant="small" tone="faint">
                    {t("form.noApps")}
                  </Text>
                )}
                {(apps ?? []).map((a) => (
                  <Checkbox
                    key={a.id}
                    label={t("form.appTools", { name: a.name })}
                    checked={selectedApps.includes(a.id)}
                    onChange={(on) => toggleApp(a.id, on)}
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
            <OrgSkillsPicker skills={orgSkills} value={skillIds} onChange={setSkillIds} />
            {existing && (
              <OwnSkills
                orgId={orgId}
                agentId={existing.id}
                canDelete={existing.ownerAccountId === me.account.id}
              />
            )}
          </FormSection>
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
    anchors,
    sections,
    unsaved,
    errors,
    saved: warnings !== undefined,
    submit: () => void save(),
    pending,
    canSubmit,
  };
}
