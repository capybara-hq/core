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
  Skeleton,
  Stack,
  Switch,
  Text,
  Textarea,
  WizardPage,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { FormError } from "../../../../../../components/form-error";
import { ModelParams } from "../../../../../../components/ModelParams";
import { OrgGate } from "../../../../../../components/OrgGate";
import { formatCost, grouped } from "../../../../../../components/TrajectoryParts";
import { Link, useRouter } from "../../../../../../i18n/navigation";
import {
  type Agent,
  findModel,
  getAgent,
  keepDeclared,
  listModels,
  type ParamValue,
  type ProviderModels,
} from "../../../../../../lib/agents";
import { ApiClientError, issueLines } from "../../../../../../lib/api";
import type { ModelRef } from "../../../../../../lib/conversations";
import {
  EVAL_PURPOSE,
  type EvalCandidate,
  type EvalEstimate,
  type EvalMode,
  type EvalSetDetail,
  estimateEvalRun,
  getEvalSet,
  listModelPurposes,
  startEvalRun,
} from "../../../../../../lib/evals";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

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
 * `/[locale]/evals/[setId]/run`：运行评测（WizardPage，三步）。
 * 1. 模式与候选：单步 / 整轮，agent 版本、模型与参数（复用 ModelParams）、指令覆盖；不改的项沿用各用例原来的设置；
 * 2. 评委开关（`eval` 用途没有生效的映射时禁用，并链接到用途设置）与 token 上限（留空用部署默认）；
 * 3. 估算（D5：预计请求数、token 与成本，以及上限）并确认，开始后进运行页。
 */
export default function RunWizardPage() {
  const { setId } = useParams<{ setId: string }>();
  return (
    <OrgGate>
      {(orgId) => <RunWizardInOrg key={`${orgId}\n${setId}`} orgId={orgId} setId={setId} />}
    </OrgGate>
  );
}

function RunWizardInOrg({ orgId, setId }: { orgId: string; setId: string }) {
  const t = useTranslations("evals");
  const errorMessage = useErrorMessage();
  const { state } = useLoad(async () => {
    const { set } = await getEvalSet(orgId, setId);
    const [{ agent }, { providers }] = await Promise.all([
      getAgent(orgId, set.agentId),
      listModels(orgId),
    ]);
    return { set, agent, providers };
  }, [orgId, setId]);
  if (state.kind === "ready") return <RunWizard orgId={orgId} {...state.data} />;
  return (
    <WizardPage
      header={{
        parent: { label: t("title"), href: `/evals/${encodeURIComponent(setId)}` },
        title: t("wizard.title"),
      }}
      steps={STEPS.map((s) => t(`wizard.steps.${s}`))}
      current={0}
      actionRow={{ primary: { label: t("wizard.next"), onSelect: () => {}, disabled: true } }}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : (
        <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
      )}
    </WizardPage>
  );
}

type EstimateState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; estimate: EvalEstimate }
  | { kind: "error"; message: string; lines: string[] };

function RunWizard({
  orgId,
  set,
  agent,
  providers,
}: {
  orgId: string;
  set: EvalSetDetail;
  agent: Agent;
  providers: ProviderModels[];
}) {
  const t = useTranslations("evals");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const setHref = `/evals/${encodeURIComponent(set.id)}`;
  // 评委用途是否已映射：读不到（如没有权限）时按未映射处理
  const purposes = useLoad(
    () =>
      listModelPurposes(orgId).then(
        (r) => r.purposes.find((p) => p.purpose === EVAL_PURPOSE)?.effective != null,
      ),
    [orgId],
  );
  const judgeAvailable = purposes.state.kind === "ready" && purposes.state.data;

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
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ message: string; lines: string[] } | null>(null);

  const ref = model === "" ? null : decode(model);
  const decl = ref === null ? [] : (findModel(providers, ref)?.parameters ?? []);
  const judge = judgeOn && judgeAvailable;
  const cap = tokenCap.trim() === "" ? null : Number(tokenCap);
  const capInvalid = cap !== null && !(Number.isInteger(cap) && cap >= 1);

  const candidate = (): EvalCandidate => ({
    ...(version !== "" && { agentVersion: Number(version) }),
    ...(ref !== null && { model: ref }),
    ...(ref !== null && Object.keys(params).length > 0 && { modelParams: params }),
    ...(override && { instructions }),
  });
  const input = () => ({ mode, candidate: candidate(), judge });

  const runEstimate = async () => {
    setEstimate({ kind: "loading" });
    try {
      const r = await estimateEvalRun(orgId, set.id, input());
      setEstimate({ kind: "ready", estimate: r.estimate });
    } catch (e) {
      setEstimate({ kind: "error", message: errorMessage(e), lines: issueLines(e) });
    }
  };

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
    if (step === 1) void runEstimate();
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
            disabled: estimate.kind !== "ready" || starting,
          },
  };

  const versions = Array.from({ length: agent.currentVersion }, (_, i) => agent.currentVersion - i);
  const modelOptions = [
    { value: "", label: t("wizard.modelKeep") },
    ...providers.flatMap((p) =>
      p.models.map((m) => ({
        value: encode({ provider: p.provider, model: m.id }),
        label: `${p.provider}/${m.id}`,
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
            {purposes.state.kind !== "loading" && !judgeAvailable ? (
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
            help={t("wizard.tokenCapHint")}
            {...(capInvalid && { error: t("wizard.tokenCapInvalid") })}
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
              <EstimateView estimate={estimate.estimate} cap={cap} />
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
      header={{ parent: { label: set.name, href: setHref }, title: t("wizard.title") }}
      steps={STEPS.map((s) => t(`wizard.steps.${s}`))}
      current={step}
      actionRow={actionRow}
    >
      {body}
    </WizardPage>
  );
}

/** 估算数字（D5）与 token 上限；预计超过上限时提示会在上限处停下。 */
function EstimateView({ estimate: e, cap }: { estimate: EvalEstimate; cap: number | null }) {
  const t = useTranslations("evals.wizard.estimate");
  return (
    <Stack gap={8}>
      <KeyValue
        keyWidth="16ch"
        rows={[
          { k: t("cases"), v: grouped.format(e.cases) },
          { k: t("modelRequests"), v: grouped.format(e.modelRequests) },
          { k: t("judgeRequests"), v: grouped.format(e.judgeRequests) },
          { k: t("tokens"), v: grouped.format(e.estimatedTokens) },
          { k: t("cost"), v: formatCost(e.estimatedCost, e.currency) },
          { k: t("tokenCap"), v: cap === null ? t("tokenCapDefault") : grouped.format(cap) },
        ]}
      />
      {cap !== null && e.estimatedTokens > cap ? <Text tone="warn">{t("overCap")}</Text> : null}
    </Stack>
  );
}
