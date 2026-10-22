"use client";

import {
  AttachmentChip,
  Checkbox,
  Field,
  FileButton,
  Input,
  RadioGroup,
  Stack,
  Text,
  useToast,
  WizardPage,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { AdminGate } from "../../../../../../components/AdminGate";
import { FormError } from "../../../../../../components/form-error";
import { PermissionReview } from "../../../../../../components/PermissionReview";
import { Link, useRouter } from "../../../../../../i18n/navigation";
import {
  type AdminPlugin,
  approvePlugin,
  enablePlugin,
  ingestNpm,
  installPlugin,
  listAdminPlugins,
  type PackageReview,
  reviewSensitive,
  uploadPluginPackage,
} from "../../../../../../lib/admin-plugins";
import { ApiClientError, issueLines } from "../../../../../../lib/api";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/**
 * `/[locale]/admin/plugins/install`：安装 / 升级插件（企业管理员，WizardPage，三步）。
 * 1. 选来源：上传 tgz（有进度、可取消）或 npm 包名加版本；内核返回审阅结果。
 * 2. 安装确认页：权限分组（敏感项高亮并写明原因、网络标「声明，平台不拦截」、迁移警告）；升级时显示新增 /
 *    减少的权限与在途调用的等待时限。与内置 / 配置声明的插件重名、升级时包名不符都不能继续。
 * 3. 确认：有敏感项时须勾选「我已了解敏感项」；依次 install → approve（无需批准时跳过）→ 可选 enable。
 * `?upgrade=<name>` 为升级（插件详情页的「升级」）。
 */
export default function PluginInstallPage() {
  return (
    <AdminGate>
      <PluginInstall />
    </AdminGate>
  );
}

/** 查询串只在浏览器里读（会话加载前不渲染本组件，所以不涉及服务端渲染）。 */
const upgradeTarget = (): string | null => {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("upgrade");
  return v === null || v === "" ? null : v;
};

type Step = 0 | 1 | 2;
type Problem = { message: string; extra: string[] };

function PluginInstall() {
  const t = useTranslations("admin.plugins.wizard");
  const tp = useTranslations("admin.plugins");
  const td = useTranslations("admin.plugins.detail");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [target] = useState(upgradeTarget);
  const existing = useLoad(listAdminPlugins, []);
  const plugins: AdminPlugin[] = existing.state.kind === "ready" ? existing.state.data.plugins : [];
  const drainSeconds = existing.state.kind === "ready" ? existing.state.data.drainSeconds : 30;

  const [step, setStep] = useState<Step>(0);
  const [source, setSource] = useState<"file" | "npm">("file");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<Problem>();
  const [review, setReview] = useState<PackageReview | null>(null);
  const [ack, setAck] = useState(false);
  const [enableAfter, setEnableAfter] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Problem & { installed: string | null }>();

  const problem = (e: unknown): Problem => ({ message: errorMessage(e), extra: issueLines(e) });

  const fetchReview = async () => {
    setFetchError(undefined);
    setCancelled(false);
    setFetching(true);
    try {
      let r: PackageReview;
      if (source === "file") {
        if (file === null) return;
        const ctrl = new AbortController();
        abort.current = ctrl;
        setProgress(0);
        r = await uploadPluginPackage(file, { onProgress: setProgress, signal: ctrl.signal });
      } else {
        r = await ingestNpm(pkg.trim(), version.trim());
      }
      setReview(r);
      setAck(false);
      setStep(1);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setCancelled(true);
      else setFetchError(problem(e));
    } finally {
      abort.current = null;
      setProgress(null);
      setFetching(false);
    }
  };

  const current = review === null ? undefined : plugins.find((p) => p.name === review.name);
  const blocked: string | null =
    review === null
      ? null
      : target !== null && review.name !== target
        ? t("upgradeMismatch", { got: review.name, want: target })
        : current?.source === "builtin"
          ? t("conflictBuiltin", { name: review.name })
          : current?.source === "config"
            ? t("conflictConfig", { name: review.name })
            : null;
  const upgrading = current?.source === "install";
  const sensitive = review !== null && reviewSensitive(review);
  // 升级启用中的插件：期望状态不变（仍启用），不需要再启用
  const offerEnable = !upgrading || current?.desired?.state === "disabled";

  const submit = async () => {
    if (review === null) return;
    setSubmitting(true);
    setSubmitError(undefined);
    let installed: string | null = null;
    try {
      await installPlugin(review.name, review.sha256);
      installed = review.name;
      try {
        await approvePlugin(review.name, {
          sha256: review.sha256,
          reviewHash: review.reviewHash,
        });
      } catch (e) {
        // 快照已覆盖这个版本的权限（如只少了权限的升级）：无需批准
        if (!(e instanceof ApiClientError && e.code === "plugin.not_pending")) throw e;
      }
      if (offerEnable && enableAfter) {
        await enablePlugin(review.name);
      }
      toast.success(t("done", { name: review.name }));
      router.push(`/admin/plugins/${encodeURIComponent(review.name)}`);
    } catch (e) {
      setSubmitError({ ...problem(e), installed });
    } finally {
      setSubmitting(false);
    }
  };

  const back = () => {
    setSubmitError(undefined);
    setStep((s) => (s > 0 ? ((s - 1) as Step) : s));
  };
  const cancel = {
    label: t("cancel"),
    onSelect: () => router.push(target !== null ? `/admin/plugins/${target}` : "/admin/plugins"),
  };
  const actionRow =
    step === 0
      ? {
          cancel,
          primary: {
            label: source === "file" ? t("upload") : t("fetch"),
            onSelect: () => void fetchReview(),
            loading: fetching,
            disabled: fetching || (source === "file" ? file === null : pkg.trim() === ""),
          },
        }
      : step === 1
        ? {
            cancel,
            secondary: { label: t("back"), onSelect: back },
            primary: {
              label: t("next"),
              onSelect: () => setStep(2),
              disabled: blocked !== null,
            },
          }
        : {
            cancel,
            secondary: { label: t("back"), onSelect: back, disabled: submitting },
            primary: {
              label: t("install"),
              onSelect: () => void submit(),
              loading: submitting,
              disabled: submitting || (sensitive && !ack),
            },
          };

  return (
    <WizardPage
      header={{
        parent: { label: tp("title"), href: "/admin/plugins" },
        title: target !== null ? t("upgradeTitle", { name: target }) : t("title"),
      }}
      steps={[t("steps.source"), t("steps.review"), t("steps.confirm")]}
      current={step}
      actionRow={actionRow}
    >
      {step === 0 && (
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
            <Stack gap={8}>
              <Text variant="small" tone="muted">
                {t("fileHint")}
              </Text>
              <Stack direction="row" gap={8} align="center">
                <FileButton
                  label={t("choose")}
                  accept=".tgz,application/gzip,application/x-gzip"
                  disabled={fetching}
                  onFiles={(files) => {
                    setFile(files[0] ?? null);
                    setCancelled(false);
                    setFetchError(undefined);
                  }}
                />
                {file === null && <Text tone="muted">{t("noFile")}</Text>}
              </Stack>
              {file !== null && (
                <AttachmentChip
                  name={file.name}
                  size={file.size}
                  status={progress !== null ? "uploading" : "ready"}
                  progress={progress ?? 0}
                  onRemove={() => {
                    if (abort.current !== null) abort.current.abort();
                    else setFile(null);
                  }}
                />
              )}
              {cancelled && <Text tone="muted">{t("cancelled")}</Text>}
            </Stack>
          ) : (
            <Stack gap={12}>
              <Field label={t("npmPackage")}>
                <Input value={pkg} onChange={(e) => setPkg(e.target.value)} />
              </Field>
              <Field label={t("npmVersion")} help={t("npmVersionHelp")}>
                <Input value={version} onChange={(e) => setVersion(e.target.value)} />
              </Field>
            </Stack>
          )}
          {fetchError !== undefined && (
            <FormError message={fetchError.message} extra={fetchError.extra} />
          )}
        </Stack>
      )}
      {step === 1 && review !== null && (
        <Stack gap={16}>
          <Stack gap={4}>
            <Text>{t("package", { name: review.name, version: review.version })}</Text>
            <Text variant="small" tone="muted">
              {t("sha", { sha: review.sha256 })}
            </Text>
          </Stack>
          {blocked !== null ? (
            <FormError message={blocked} />
          ) : upgrading && current !== undefined ? (
            <Stack gap={4}>
              <Text>{t("upgradeFrom", { from: current.version, to: review.version })}</Text>
              <Text tone="warn">{td("drainHint", { seconds: drainSeconds })}</Text>
            </Stack>
          ) : (
            <Text tone="muted">{t("newInstall")}</Text>
          )}
          <PermissionReview
            plugin={review.name}
            groups={review.permissions}
            {...(upgrading && { added: review.added, removed: review.removed })}
            warnings={review.warnings}
          />
        </Stack>
      )}
      {step === 2 && review !== null && (
        <Stack gap={16}>
          <Text>{t("package", { name: review.name, version: review.version })}</Text>
          {upgrading && <Text tone="warn">{td("drainHint", { seconds: drainSeconds })}</Text>}
          {sensitive && (
            <Stack gap={8}>
              <Text tone="warn">{t("ackHint")}</Text>
              <Checkbox checked={ack} onChange={setAck} label={t("ack")} />
            </Stack>
          )}
          {offerEnable && (
            <Checkbox checked={enableAfter} onChange={setEnableAfter} label={t("enableAfter")} />
          )}
          {submitError !== undefined && (
            <Stack gap={8}>
              <FormError
                message={
                  submitError.installed !== null
                    ? `${t("failedAfterInstall")} ${submitError.message}`
                    : submitError.message
                }
                extra={submitError.extra}
              />
              {submitError.installed !== null && (
                <Text>
                  <Link href={`/admin/plugins/${encodeURIComponent(submitError.installed)}`}>
                    {submitError.installed}
                  </Link>
                </Text>
              )}
            </Stack>
          )}
        </Stack>
      )}
    </WizardPage>
  );
}
