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
  type AdminExtension,
  approveExtension,
  enableExtension,
  ingestNpm,
  installExtension,
  listAdminExtensions,
  type PackageReview,
  reviewSensitive,
  UPLOAD_SESSION_EXPIRED,
  uploadExtensionPackage,
} from "../../../../../../lib/admin-extensions";
import { ApiClientError, issueLines } from "../../../../../../lib/api";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/**
 * `/[locale]/admin/extensions/install`: install / upgrade an extension (enterprise admins,
 * WizardPage, three steps).
 * 1. Source: upload a tgz (with progress, cancellable) or an npm package name and version; the
 *    kernel returns the review.
 * 2. Install confirmation: permission groups (sensitive items highlighted with the reason, network
 *    marked "declared only, not enforced", migration warnings); an upgrade shows the added / removed
 *    permissions and the time limit for in-flight calls. A name clash with a built-in /
 *    config-declared extension, or a package name mismatch on upgrade, cannot continue.
 * 3. Confirm: with sensitive items, "I understand the sensitive items" must be checked; then install
 *    -> approve (skipped when no approval is needed) -> optionally enable.
 * `?upgrade=<name>` is an upgrade ("Upgrade" on the extension page).
 */
export default function ExtensionInstallPage() {
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
  const t = useTranslations("admin.extensions.wizard");
  const tp = useTranslations("admin.extensions");
  const td = useTranslations("admin.extensions.detail");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [target] = useState(upgradeTarget);
  const existing = useLoad(listAdminExtensions, []);
  const plugins: AdminExtension[] =
    existing.state.kind === "ready" ? existing.state.data.extensions : [];
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
        r = await uploadExtensionPackage(file, { onProgress: setProgress, signal: ctrl.signal });
      } else {
        r = await ingestNpm(pkg.trim(), version.trim());
      }
      setReview(r);
      setAck(false);
      setStep(1);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setCancelled(true);
      else if (e instanceof ApiClientError && e.code === UPLOAD_SESSION_EXPIRED)
        setFetchError({ message: t("sessionExpired"), extra: [] });
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
      await installExtension(review.name, review.sha256);
      installed = review.name;
      try {
        await approveExtension(review.name, {
          sha256: review.sha256,
          reviewHash: review.reviewHash,
        });
      } catch (e) {
        // 快照已覆盖这个版本的权限（如只少了权限的升级）：无需批准
        if (!(e instanceof ApiClientError && e.code === "extension.not_pending")) throw e;
      }
      if (offerEnable && enableAfter) {
        await enableExtension(review.name);
      }
      toast.success(t("done", { name: review.name }));
      router.push(`/admin/extensions/${encodeURIComponent(review.name)}`);
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
    onSelect: () =>
      router.push(target !== null ? `/admin/extensions/${target}` : "/admin/extensions"),
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
        parent: { label: tp("title"), href: "/admin/extensions" },
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
            {...(upgrading && { added: review.addedItems, removed: review.removed })}
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
                  <Link href={`/admin/extensions/${encodeURIComponent(submitError.installed)}`}>
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
