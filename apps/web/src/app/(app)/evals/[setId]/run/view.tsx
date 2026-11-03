"use client";

import {
  type ActionRowProps,
  Card,
  Field,
  FormSection,
  Input,
  KeyValue,
  RadioGroup,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  WizardPage,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { FormError } from "../../../../../components/form-error";
import { ModelParams } from "../../../../../components/ModelParams";
import { usePagePath } from "../../../../../components/shell/path";
import { grouped, useFormatCost } from "../../../../../components/TrajectoryParts";
import { Link, useRouter } from "../../../../../i18n/navigation";
import {
  type Agent,
  findModel,
  keepDeclared,
  type ParamValue,
  type ProviderModels,
} from "../../../../../lib/agents";
import { ApiClientError, issueLines } from "../../../../../lib/api";
import type { ModelRef } from "../../../../../lib/conversations";
import {
  EVAL_PURPOSE,
  type EvalCandidate,
  type EvalEstimate,
  type EvalMode,
  type EvalSetDetail,
  estimateEvalRun,
  type PurposeView,
  startEvalRun,
} from "../../../../../lib/evals";
import { labelLocale, modelLabel } from "../../../../../lib/extension-label";
import { useErrorMessage } from "../../../../../lib/use-error-message";

const STEPS = ["candidate", "judge", "confirm"] as const;

/** 下拉框的值：`provider/model`（供应商插件名不含 `/`，模型 id 可能含）。 */
const encode = (r: ModelRef) => `${r.provider}/${r.model}`;
function decode(v: string): ModelRef | null {
  const i = v.indexOf("/");
  return i <= 0 ? null : { provider: v.slice(0, i), model: v.slice(i + 1) };
}

/** 设置模型用途的页面（组织设置；评委用途 `eval` 未映射时链接到这里）。 */
const PURPOSES_HREF = "/settings/models";

/**
 * `/evals/[setId]/run`: run an eval (WizardPage, three steps).
 * 1. Mode and candidate: single step / whole run, agent version, model and parameters (reusing
 *    ModelParams), instruction override; what is left alone keeps each case's own setting;
 * 2. the judge switch (disabled when the `eval` purpose has no effective mapping, linking to the
 *    purpose settings) and the token cap (empty: the deployment default);
 * 3. the estimate (D5: requests, tokens, cost and the cap) and confirmation; starting opens the run.
 * The set, its agent, the models and the model purposes come from the server (`purposes` null: the
 * server could not read them, the judge step draws the error); the estimate follows the input.
 */
type EstimateState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; estimate: EvalEstimate; cap: number }
  | { kind: "error"; message: string; lines: string[] };

/** 改动后等多久再估算（输入上限、参数时不逐键请求；内核只读用例上存好的计划列）。 */
const ESTIMATE_DEBOUNCE_MS = 500;

export default function RunWizard({
  orgId,
  set,
  agent,
  providers,
  purposes,
}: {
  orgId: string;
  set: EvalSetDetail;
  agent: Agent;
  providers: ProviderModels[];
  purposes: PurposeView[] | null;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const setHref = `/evals/${encodeURIComponent(set.id)}`;
  // Whether the judge purpose is mapped: when it could not be read the error shows and the judge
  // switch is disabled too
  const judgeAvailable =
    purposes !== null && purposes.find((p) => p.purpose === EVAL_PURPOSE)?.effective != null;

  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<EvalMode>("step");
  const [version, setVersion] = useState("");
  const [model, setModel] = useState("");
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [override, setOverride] = useState(false);
  const [instructions, setInstructions] = useState(agent.definition.instructions);
  const [judgeOn, setJudgeOn] = useState(false);
  const [tokenCap, setTokenCap] = useState("");
  const [estimate, setEstimate] = useState<EstimateState>({ kind: "idle" });
  /** 部署默认与部署上限（来自最近一次估算响应）。 */
  const [caps, setCaps] = useState<{ defaultTokenCap: number; maxTokenCap: number } | null>(null);
  /** 估算请求的序号：只认最后一次发出的响应，先发的慢响应不覆盖后发的。 */
  const seq = useRef(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ message: string; lines: string[] } | null>(null);

  const ref = model === "" ? null : decode(model);
  const decl = ref === null ? [] : (findModel(providers, ref)?.parameters ?? []);
  const judge = judgeOn && judgeAvailable;
  const cap = tokenCap.trim() === "" ? null : Number(tokenCap);
  const capError =
    cap === null
      ? undefined
      : !(Number.isInteger(cap) && cap >= 1)
        ? t("wizard.tokenCapInvalid")
        : caps !== null && cap > caps.maxTokenCap
          ? t("wizard.tokenCapTooLarge", { max: grouped.format(caps.maxTokenCap) })
          : undefined;
  const capInvalid = capError !== undefined;

  const candidate = (): EvalCandidate => ({
    ...(version !== "" && { agentVersion: Number(version) }),
    ...(ref !== null && { model: ref }),
    ...(ref !== null && Object.keys(params).length > 0 && { modelParams: params }),
    ...(override && { instructions }),
  });
  const input = () => ({ mode, candidate: candidate(), judge });
  const estimateBody = { ...input(), ...(cap !== null && { tokenCap: cap }) };
  const estimateKey = JSON.stringify(estimateBody);
  const estimating = step >= 1 && !capInvalid;

  // From the second step on, any change (the cap too) estimates again (debounced); an invalid cap
  // sends nothing and voids the estimate in flight.
  // ssr-exempt: the estimate follows the person's input (from step 2), never the first paint
  useEffect(() => {
    const id = ++seq.current;
    if (!estimating) {
      setEstimate({ kind: "idle" });
      return;
    }
    setEstimate({ kind: "loading" });
    const body = JSON.parse(estimateKey) as Parameters<typeof estimateEvalRun>[2];
    const timer = setTimeout(() => {
      estimateEvalRun(orgId, set.id, body).then(
        (r) => {
          if (id !== seq.current) return;
          setCaps({ defaultTokenCap: r.defaultTokenCap, maxTokenCap: r.maxTokenCap });
          setEstimate({ kind: "ready", estimate: r.estimate, cap: r.effectiveTokenCap });
        },
        (e: unknown) => {
          if (id !== seq.current) return;
          setEstimate({ kind: "error", message: errorMessage(e), lines: issueLines(e) });
        },
      );
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [estimating, estimateKey, orgId, set.id, errorMessage]);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { run } = await startEvalRun(orgId, set.id, {
        ...input(),
        ...(cap !== null && { tokenCap: cap }),
      });
      router.push(`/evals/runs/${encodeURIComponent(run.id)}`);
    } catch (e) {
      setStartError({ message: errorMessage(e), lines: issueLines(e) });
      setStarting(false);
    }
  };

  const next = () => {
    setStartError(null);
    setStep((s) => s + 1);
  };

  const actionRow: ActionRowProps = {
    cancel: { label: tc("cancel"), onSelect: () => router.push(setHref) },
    ...(step > 0 && {
      secondary: { label: t("wizard.back"), onSelect: () => setStep((s) => s - 1) },
    }),
    primary:
      step < STEPS.length - 1
        ? { label: t("wizard.next"), onSelect: next, disabled: step === 1 && capInvalid }
        : {
            label: t("wizard.start"),
            onSelect: () => void start(),
            loading: starting,
            disabled: estimate.kind !== "ready" || capInvalid || starting,
          },
  };

  const versions = Array.from({ length: agent.currentVersion }, (_, i) => agent.currentVersion - i);
  const modelOptions = [
    { value: "", label: t("wizard.modelKeep") },
    ...providers.flatMap((p) =>
      p.models.map((m) => ({
        value: encode({ provider: p.provider, model: m.id }),
        label: modelLabel(
          { name: p.provider, displayName: p.displayName },
          m.displayName || m.id,
          labelLocale(locale),
        ),
      })),
    ),
  ];

  let body: ReactNode;
  if (step === 0) {
    body = (
      <Stack gap={24}>
        <FormSection id="mode" title={t("wizard.mode")}>
          <RadioGroup
            label={t("wizard.mode")}
            variant="card"
            value={mode}
            onChange={(v) => setMode(v as EvalMode)}
            options={(["step", "run"] as const).map((m) => ({
              value: m,
              label: t(`mode.${m}`),
              description: t(`mode.${m}Hint`),
            }))}
          />
        </FormSection>
        <FormSection
          id="candidate"
          title={t("wizard.candidate")}
          description={t("wizard.candidateHint")}
        >
          <Stack gap={12}>
            <Field label={t("wizard.version")}>
              <Select
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                options={[
                  { value: "", label: t("wizard.versionKeep") },
                  ...versions.map((v) => ({
                    value: String(v),
                    label: t("wizard.versionValue", { n: v }),
                  })),
                ]}
              />
            </Field>
            <Field label={t("wizard.model")}>
              <Select
                value={model}
                onChange={(e) => {
                  const v = e.target.value;
                  const r = v === "" ? null : decode(v);
                  setModel(v);
                  setParams((p) =>
                    r === null ? {} : keepDeclared(findModel(providers, r)?.parameters ?? [], p),
                  );
                }}
                options={modelOptions}
              />
            </Field>
            {decl.length > 0 ? (
              <Stack gap={12}>
                <Text variant="small" tone="muted">
                  {t("wizard.params")}
                </Text>
                <ModelParams
                  parameters={decl}
                  value={params}
                  onChange={setParams}
                  locale={locale}
                />
              </Stack>
            ) : null}
            <Stack direction="row" gap={12} align="center">
              <Switch
                label={t("wizard.instructionsOverride")}
                checked={override}
                onChange={setOverride}
              />
              <Text>{t("wizard.instructionsOverride")}</Text>
            </Stack>
            {override ? (
              <Field label={t("wizard.instructions")} help={t("wizard.instructionsHint")}>
                <Textarea
                  value={instructions}
                  rows={8}
                  maxLength={100_000}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </Field>
            ) : null}
          </Stack>
        </FormSection>
      </Stack>
    );
  } else if (step === 1) {
    body = (
      <Stack gap={24}>
        <FormSection id="judge" title={t("wizard.judge")} description={t("wizard.judgeHint")}>
          <Stack gap={8}>
            <Stack direction="row" gap={12} align="center">
              <Switch
                label={t("wizard.judge")}
                checked={judge}
                disabled={!judgeAvailable}
                onChange={setJudgeOn}
              />
              <Text tone={judgeAvailable ? "ink" : "muted"}>{t("wizard.judge")}</Text>
            </Stack>
            {purposes === null ? (
              <FormError message={errorMessage(new ApiClientError(0, "unknown", ""))} />
            ) : !judgeAvailable ? (
              <Stack gap={4}>
                <Text tone="warn">{t("wizard.judgeUnmapped")}</Text>
                <Link href={PURPOSES_HREF}>{t("wizard.judgeConfigure")}</Link>
              </Stack>
            ) : null}
          </Stack>
        </FormSection>
        <FormSection id="cap" title={t("wizard.tokenCap")}>
          <Field
            label={t("wizard.tokenCap")}
            help={
              caps === null
                ? t("wizard.tokenCapHint")
                : `${t("wizard.tokenCapRange", {
                    default: grouped.format(caps.defaultTokenCap),
                    max: grouped.format(caps.maxTokenCap),
                  })} ${t("wizard.tokenCapHint")}`
            }
            {...(capError !== undefined && { error: capError })}
          >
            <Input
              type="number"
              min={1}
              step={1}
              value={tokenCap}
              onChange={(e) => setTokenCap(e.target.value)}
            />
          </Field>
        </FormSection>
      </Stack>
    );
  } else {
    body = (
      <Stack gap={16}>
        <KeyValue
          keyWidth="16ch"
          rows={[
            { k: t("wizard.summary.mode"), v: t(`mode.${mode}`) },
            {
              k: t("wizard.version"),
              v:
                version === "" ? t("wizard.versionKeep") : t("wizard.versionValue", { n: version }),
            },
            { k: t("wizard.model"), v: ref === null ? t("wizard.modelKeep") : encode(ref) },
            {
              k: t("wizard.summary.judge"),
              v: judge ? t("wizard.summary.on") : t("wizard.summary.off"),
            },
          ]}
        />
        <section aria-label={t("wizard.estimate.title")}>
          <Card title={t("wizard.estimate.title")}>
            {estimate.kind === "ready" ? (
              <EstimateView estimate={estimate.estimate} cap={estimate.cap} />
            ) : estimate.kind === "error" ? (
              <FormError message={estimate.message} extra={estimate.lines} />
            ) : (
              <Text tone="muted">{t("wizard.estimating")}</Text>
            )}
          </Card>
        </section>
        {startError !== null ? (
          <FormError message={startError.message} extra={startError.lines} />
        ) : null}
      </Stack>
    );
  }

  return (
    <WizardPage
      header={{
        path: [
          ...scope,
          { label: "evals", href: "/evals" },
          { label: set.name, href: setHref },
          { label: "run" },
        ],
        title: t("wizard.title"),
      }}
      steps={STEPS.map((s) => t(`wizard.steps.${s}`))}
      current={step}
      actionRow={actionRow}
    >
      {body}
    </WizardPage>
  );
}

/**
 * 估算数字（D5）与本次生效的 token 上限：总数含评委，评委的份额单列；预计（总数）超过上限时提示会在上限处停下。
 */
function EstimateView({ estimate: e, cap }: { estimate: EvalEstimate; cap: number }) {
  const t = useTranslations("evals.wizard.estimate");
  const formatCost = useFormatCost();
  const judgeTokens = e.judgeTokens ?? 0;
  return (
    <Stack gap={8}>
      <KeyValue
        keyWidth="16ch"
        rows={[
          { k: t("cases"), v: grouped.format(e.cases) },
          { k: t("modelRequests"), v: grouped.format(e.modelRequests) },
          { k: t("judgeRequests"), v: grouped.format(e.judgeRequests) },
          { k: t("tokens"), v: grouped.format(e.estimatedTokens) },
          ...(judgeTokens > 0
            ? [
                {
                  k: t("judgeShare"),
                  v: t("judgeShareValue", {
                    tokens: grouped.format(judgeTokens),
                    cost: formatCost(e.judgeCost ?? null, e.currency),
                  }),
                },
              ]
            : []),
          { k: t("cost"), v: formatCost(e.estimatedCost, e.currency) },
          { k: t("tokenCap"), v: grouped.format(cap) },
        ]}
      />
      {e.estimatedTokens > cap ? <Text tone="warn">{t("overCap")}</Text> : null}
    </Stack>
  );
}
