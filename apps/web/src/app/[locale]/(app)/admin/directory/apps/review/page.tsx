"use client";

import {
  Badge,
  Card,
  Checkbox,
  Field,
  FileButton,
  Input,
  KeyValue,
  RadioGroup,
  Stack,
  Text,
  useToast,
  WizardPage,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AdminGate } from "../../../../../../../components/AdminGate";
import { FormError } from "../../../../../../../components/form-error";
import { PermissionReview } from "../../../../../../../components/PermissionReview";
import { Link, useRouter } from "../../../../../../../i18n/navigation";
import { issueLines } from "../../../../../../../lib/api";
import {
  type AppConfirmResult,
  type AppPrepared,
  type AppReview,
  type AppReviewPlugin,
  appReviewSensitive,
  confirmApp,
  endpointLeaves,
  importCatalogEntry,
  type PermissionsMismatch,
  prepareAppNpm,
  showValue,
  uploadDirectoryPackage,
} from "../../../../../../../lib/directory";
import { useErrorMessage } from "../../../../../../../lib/use-error-message";

/**
 * `/[locale]/admin/directory/apps/review`：导入应用（企业管理员，WizardPage）。一次审阅整个应用：
 * 1. 选应用包：上传 tgz 或 npm 包名；从清单引入应用时（`?catalog=<来源>&name=<条目>&version=<版本>`）直接按清单下载、
 *    校验并暂存，跳过这一步；
 * 2. 审阅：每个插件的权限分组（敏感项高亮）与动作（安装 / 升级 / 保持），连接器模板的端点与认证方式，技能列表；
 *    清单权限摘要与包不一致时警告；
 * 3. 确认：「同时把插件装到部署」（不勾选时说明插件只记为目录条目、组织用不了），有敏感项时还须勾选「我已了解敏感项」。
 */
export default function AppReviewPage() {
  return (
    <AdminGate>
      <AppReviewWizard />
    </AdminGate>
  );
}

type CatalogRef = { sourceId: string; name: string; version: string };

/**
 * 查询串在挂载后的 effect 里读：客户端跳转（router.push）时，新页面渲染那一刻地址栏可能还是旧的，提交后才更新
 * （不用 useSearchParams：避免整页退化为客户端渲染的 Suspense 要求）。
 */
function catalogRef(): CatalogRef | null {
  const q = new URLSearchParams(window.location.search);
  const sourceId = q.get("catalog");
  const name = q.get("name");
  const version = q.get("version");
  return sourceId && name && version ? { sourceId, name, version } : null;
}

type Step = 0 | 1 | 2;
type Problem = { message: string; extra: string[] };

function AppReviewWizard() {
  const t = useTranslations("directory.admin.review");
  const ta = useTranslations("directory.admin");
  const tw = useTranslations("admin.plugins.wizard");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  // undefined：还没读查询串
  const [catalog, setCatalog] = useState<CatalogRef | null | undefined>(undefined);
  const [step, setStep] = useState<Step>(0);
  const [source, setSource] = useState<"file" | "npm">("file");
  const [file, setFile] = useState<File | null>(null);
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<Problem>();
  const [prepared, setPrepared] = useState<AppPrepared | null>(null);
  const [deployPlugins, setDeployPlugins] = useState(false);
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Problem>();
  const [result, setResult] = useState<AppConfirmResult | null>(null);
  const started = useRef(false);

  const problem = (e: unknown): Problem => ({ message: errorMessage(e), extra: issueLines(e) });

  const accept = (p: AppPrepared) => {
    setPrepared(p);
    setAck(false);
    setStep(1);
  };

  // 从清单引入应用：进页面就下载、校验并暂存（只做一次）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时执行
  useEffect(() => {
    const catalog = catalogRef();
    setCatalog(catalog);
    if (catalog === null || started.current) return;
    started.current = true;
    setFetching(true);
    importCatalogEntry(
      { sourceId: catalog.sourceId, kind: "app", name: catalog.name },
      catalog.version,
    )
      .then(
        (r) => {
          if ("stagingId" in r) accept(r);
        },
        (e: unknown) => setFetchError(problem(e)),
      )
      .finally(() => setFetching(false));
  }, []);

  const fetchReview = async () => {
    setFetchError(undefined);
    setFetching(true);
    try {
      if (source === "file") {
        if (file === null) return;
        accept(await uploadDirectoryPackage<AppPrepared>(file, "app"));
      } else {
        accept(await prepareAppNpm(pkg.trim(), version.trim()));
      }
    } catch (e) {
      setFetchError(problem(e));
    } finally {
      setFetching(false);
    }
  };

  const review = prepared?.review ?? null;
  const sensitive = review !== null && appReviewSensitive(review);

  const submit = async () => {
    if (prepared === null) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const r = await confirmApp(prepared.stagingId, {
        reviewHash: prepared.review.reviewHash,
        deployPlugins,
      });
      toast.success(t("done", { name: r.item.name }));
      if (r.deploy === null || r.deploy.every((d) => d.result !== "failed")) {
        router.push(`/admin/directory/${r.item.id}`);
      } else setResult(r);
    } catch (e) {
      setSubmitError(problem(e));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = { label: tw("cancel"), onSelect: () => router.push("/admin/directory") };
  const back = () => {
    setSubmitError(undefined);
    setStep((s) => (s > 0 ? ((s - 1) as Step) : s));
  };
  const actionRow =
    step === 0
      ? {
          cancel,
          primary: {
            label: t("fetch"),
            onSelect: () => void fetchReview(),
            loading: fetching,
            disabled:
              fetching ||
              catalog != null ||
              (source === "file" ? file === null : pkg.trim() === ""),
          },
        }
      : step === 1
        ? {
            cancel,
            ...(catalog == null && { secondary: { label: tw("back"), onSelect: back } }),
            primary: { label: tw("next"), onSelect: () => setStep(2) },
          }
        : {
            cancel,
            secondary: { label: tw("back"), onSelect: back, disabled: submitting },
            primary: {
              label: t("confirm"),
              onSelect: () => void submit(),
              loading: submitting,
              disabled: submitting || result !== null || (sensitive && !ack),
            },
          };

  return (
    <WizardPage
      header={{ parent: { label: ta("title"), href: "/admin/directory" }, title: t("title") }}
      steps={[t("steps.source"), t("steps.review"), t("steps.confirm")]}
      current={step}
      actionRow={actionRow}
    >
      {step === 0 &&
        (catalog != null ? (
          <Stack gap={12}>
            {fetching && <Text tone="muted">{t("loadingCatalog")}</Text>}
            {fetchError !== undefined && <ProminentError problem={fetchError} />}
          </Stack>
        ) : (
          <Stack gap={16}>
            <RadioGroup
              label={t("sourceLabel")}
              value={source}
              onChange={(v) => {
                setSource(v as "file" | "npm");
                setFetchError(undefined);
              }}
              options={[
                { value: "file", label: t("sourceFile") },
                { value: "npm", label: t("sourceNpm") },
              ]}
            />
            {source === "file" ? (
              <Stack direction="row" gap={8} align="center">
                <FileButton
                  label={tw("choose")}
                  accept=".tgz,application/gzip,application/x-gzip"
                  disabled={fetching}
                  onFiles={(files) => {
                    setFile(files[0] ?? null);
                    setFetchError(undefined);
                  }}
                />
                <Text tone="muted">{file === null ? tw("noFile") : file.name}</Text>
              </Stack>
            ) : (
              <Stack gap={12}>
                <Field label={tw("npmPackage")}>
                  <Input value={pkg} onChange={(e) => setPkg(e.target.value)} />
                </Field>
                <Field label={tw("npmVersion")} help={tw("npmVersionHelp")}>
                  <Input value={version} onChange={(e) => setVersion(e.target.value)} />
                </Field>
              </Stack>
            )}
            {fetchError !== undefined && <ProminentError problem={fetchError} />}
          </Stack>
        ))}
      {step === 1 && review !== null && (
        <ReviewBody review={review} mismatch={prepared?.permissionsMismatch ?? null} />
      )}
      {step === 2 && review !== null && (
        <Stack gap={16}>
          <Text>{t("app", { name: review.name, version: review.version })}</Text>
          <Stack gap={4}>
            <Checkbox
              checked={deployPlugins}
              onChange={setDeployPlugins}
              label={t("deployPlugins")}
              disabled={result !== null}
            />
            <Text variant="small" tone={deployPlugins ? "muted" : "warn"}>
              {deployPlugins ? t("deployOn") : t("deployOff")}
            </Text>
          </Stack>
          {sensitive && (
            <Stack gap={8}>
              <Text tone="warn">{t("ackHint")}</Text>
              <Checkbox checked={ack} onChange={setAck} label={t("ack")} />
            </Stack>
          )}
          {submitError !== undefined && <ProminentError problem={submitError} />}
          {result?.deploy && (
            <Card title={t("deployResult")}>
              <Stack gap={4}>
                {result.deploy.map((d) => (
                  <Text key={d.name} tone={d.result === "failed" ? "fail" : "ink"}>
                    {d.result === "failed"
                      ? t("deployFailed", { name: d.name, version: d.version, code: d.code ?? "" })
                      : t("deployEnabled", { name: d.name, version: d.version })}
                  </Text>
                ))}
                <Text>
                  <Link href={`/admin/directory/${result.item.id}`}>{t("openItem")}</Link>
                </Text>
              </Stack>
            </Card>
          )}
        </Stack>
      )}
    </WizardPage>
  );
}

/**
 * A prominent error (e.g. `marketplace.integrity_mismatch`, `plugin.lock_mismatch`): the error row
 * in a danger card.
 */
function ProminentError({ problem }: { problem: Problem }) {
  return (
    <Card tone="danger">
      <FormError message={problem.message} extra={problem.extra} />
    </Card>
  );
}

function ReviewBody({ review, mismatch }: { review: AppReview; mismatch: PermissionsMismatch }) {
  const t = useTranslations("directory.admin.review");
  const tp = useTranslations("plugins");
  return (
    <Stack gap={16}>
      <Stack gap={4}>
        <Text>{t("app", { name: review.name, version: review.version })}</Text>
        {review.publisher !== "" && (
          <Text variant="small" tone="muted">
            {t("publisher", { publisher: review.publisher })}
          </Text>
        )}
        {review.description !== "" && <Text tone="muted">{review.description}</Text>}
      </Stack>
      {mismatch !== null && (
        <Card tone="accent">
          <Stack gap={4}>
            <Text tone="warn">{t("mismatch")}</Text>
            {mismatch.missing.length > 0 && (
              <Text variant="small" tone="warn">
                {t("mismatchMissing", { keys: mismatch.missing.join(", ") })}
              </Text>
            )}
            {mismatch.extra.length > 0 && (
              <Text variant="small" tone="muted">
                {t("mismatchExtra", { keys: mismatch.extra.join(", ") })}
              </Text>
            )}
          </Stack>
        </Card>
      )}
      <Stack gap={8}>
        <Text>{t("plugins")}</Text>
        <Text variant="small" tone="muted">
          {t("pluginsHint")}
        </Text>
        {review.plugins.map((p) => (
          <PluginReview key={p.name} plugin={p} />
        ))}
      </Stack>
      <Stack gap={8}>
        <Text>{t("templates")}</Text>
        {review.connectorTemplates.length === 0 && <Text tone="muted">{t("templatesEmpty")}</Text>}
        {review.connectorTemplates.map((c) => (
          <Card key={c.id} title={`${c.id} · ${c.plugin} / ${c.connector}`}>
            <Stack gap={8}>
              <KeyValue
                keyWidth="14ch"
                rows={endpointLeaves(c.endpoint).map(([k, v]) => ({ k, v: showValue(v) }))}
              />
              {c.editableEndpoint.length > 0 && (
                <Text variant="small" tone="muted">
                  {t("editable", { paths: c.editableEndpoint.join(", ") })}
                </Text>
              )}
              <Text variant="small">{t("auth", { type: String(c.auth.type ?? "none") })}</Text>
              {!c.endpointChecked && (
                <Text variant="small" tone="warn">
                  {t("unchecked")}
                </Text>
              )}
            </Stack>
          </Card>
        ))}
      </Stack>
      <Stack gap={8}>
        <Text>{t("skills")}</Text>
        {review.skills.length === 0 && <Text tone="muted">{t("skillsEmpty")}</Text>}
        {review.skills.map((s) => (
          <Stack key={s.path} gap={0}>
            <Text>{`${s.name} · ${t("skillFiles", { n: s.files })}`}</Text>
            <Text variant="small" tone="muted">
              {s.description}
            </Text>
          </Stack>
        ))}
      </Stack>
      {review.sensitive && <Badge tone="accent">{tp("sensitive")}</Badge>}
    </Stack>
  );
}

function PluginReview({ plugin }: { plugin: AppReviewPlugin }) {
  const t = useTranslations("directory.admin.review");
  const tp = useTranslations("plugins");
  const action =
    plugin.action === "install"
      ? t("action.install", { version: plugin.lockVersion })
      : plugin.action === "upgrade"
        ? t("action.upgrade", { from: plugin.currentVersion ?? "", to: plugin.lockVersion })
        : t("action.keep", { version: plugin.currentVersion ?? plugin.lockVersion });
  return (
    <Card
      tone={plugin.sensitive ? "accent" : "default"}
      title={`${plugin.name} (${plugin.npm})`}
      actions={
        <Stack direction="row" gap={8} align="center">
          {plugin.optional && <Badge>{t("optional")}</Badge>}
          {plugin.sensitive && <Badge tone="accent">{tp("sensitive")}</Badge>}
        </Stack>
      }
    >
      <Stack gap={8}>
        <Text>{action}</Text>
        <PermissionReview
          plugin={plugin.name}
          groups={plugin.permissions}
          {...(plugin.action === "upgrade" && {
            added: plugin.addedItems,
            removed: plugin.removed,
          })}
          warnings={plugin.warnings}
        />
      </Stack>
    </Card>
  );
}
