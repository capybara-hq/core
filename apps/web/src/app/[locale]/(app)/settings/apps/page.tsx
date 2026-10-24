"use client";

import { Button, Card, Dialog, SettingsPage, Skeleton, Stack, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatTime } from "../../../../../components/ApprovalCard";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSettingsNav } from "../../../../../components/settings-nav";
import { ApiClientError } from "../../../../../lib/api";
import {
  type AppInstall,
  listAppInstalls,
  type UninstallReport,
  uninstallApp,
} from "../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/apps`: the plugins (app bundles) this org installed from the catalog
 * (SettingsPage, admins). Each lists its status and components (created by the install / existing)
 * and can be uninstalled (a failed or interrupted install can be "cleaned up"); after an uninstall
 * the `UninstallReport` shows what was removed, what was kept and why. An install still in progress
 * (`plugin.install_in_progress`) gets a friendly explanation.
 */
export default function AppsPage() {
  return <OrgGate>{(orgId) => <Apps key={orgId} orgId={orgId} />}</OrgGate>;
}

function Apps({ orgId }: { orgId: string }) {
  const t = useTranslations("directory.apps");
  const nav = useSettingsNav();
  const errorMessage = useErrorMessage();
  const { state, reload } = useLoad(() => listAppInstalls(orgId).then((r) => r.installs), [orgId]);
  const [report, setReport] = useState<{ name: string; report: UninstallReport } | null>(null);
  return (
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="apps">
      <Stack gap={16}>
        {report !== null && (
          <ReportCard name={report.name} report={report.report} onDismiss={() => setReport(null)} />
        )}
        {state.kind === "loading" ? (
          <Skeleton rows={4} />
        ) : state.kind === "error" ? (
          <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
        ) : state.data.length === 0 ? (
          <Text tone="muted">{t("empty")}</Text>
        ) : (
          state.data.map((a) => (
            <InstallCard
              key={a.id}
              orgId={orgId}
              install={a}
              onUninstalled={(r) => {
                setReport({ name: a.name, report: r });
                reload();
              }}
            />
          ))
        )}
      </Stack>
    </SettingsPage>
  );
}

function InstallCard({
  orgId,
  install,
  onUninstalled,
}: {
  orgId: string;
  install: AppInstall;
  onUninstalled(r: UninstallReport): void;
}) {
  const t = useTranslations("directory.apps");
  const ti = useTranslations("directory.org.install.step");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const broken = install.status === "failed" || install.status === "installing";

  const uninstall = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await uninstallApp(orgId, install.id);
      setConfirm(false);
      onUninstalled(r);
    } catch (e) {
      setConfirm(false);
      setError(
        e instanceof ApiClientError && e.code === "plugin.install_in_progress"
          ? t("inProgress")
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={`${install.name} ${install.version}`}
      tone={install.status === "failed" ? "danger" : "default"}
      actions={
        <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
          {broken ? t("cleanup") : t("uninstall")}
        </Button>
      }
    >
      <Stack gap={8}>
        <Text tone={install.status === "failed" ? "fail" : "muted"}>
          {`${t(`status.${install.status}`)} · ${t("installedAt", { at: formatTime(install.installedAt, locale) })}`}
        </Text>
        {install.error !== null && (
          <Text variant="small" tone="fail">
            {t("failedAt", {
              step: ti.has(install.error.step) ? ti(install.error.step) : install.error.step,
              code: install.error.code,
            })}
          </Text>
        )}
        {install.components.length > 0 && (
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("components")}
            </Text>
            {install.components.map((c) => (
              <Text key={`${c.kind}:${c.ref}`} variant="small">
                {`· ${t(`componentKind.${c.kind}`)} ${c.ref} — ${c.created ? t("created") : t("existing")}`}
              </Text>
            ))}
          </Stack>
        )}
        {error !== undefined && <FormError message={error} />}
      </Stack>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("confirm.title", { name: install.name })}
        danger
        initialFocus="cancel"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t("confirm.cancel")}
            </Button>
            <Button variant="danger-solid" loading={busy} onClick={() => void uninstall()}>
              {t("confirm.confirm")}
            </Button>
          </>
        }
      >
        <Text>{t("confirm.hint")}</Text>
      </Dialog>
    </Card>
  );
}

/** 卸载报告：移除了哪些、保留了哪些及原因。 */
function ReportCard({
  name,
  report,
  onDismiss,
}: {
  name: string;
  report: UninstallReport;
  onDismiss(): void;
}) {
  const t = useTranslations("directory.apps");
  return (
    <section aria-label={t("report.title", { name })}>
      <Card
        title={t("report.title", { name })}
        actions={<Button onClick={onDismiss}>{t("report.dismiss")}</Button>}
      >
        <Stack gap={12}>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("report.removed")}
            </Text>
            {report.removed.length === 0 && <Text variant="small">{t("report.none")}</Text>}
            {report.removed.map((c) => (
              <Text key={`${c.kind}:${c.ref}`} variant="small">
                {`− ${t(`componentKind.${c.kind}`)} ${c.ref}`}
              </Text>
            ))}
          </Stack>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("report.kept")}
            </Text>
            {report.kept.length === 0 && <Text variant="small">{t("report.none")}</Text>}
            {report.kept.map((c) => (
              <Text key={`${c.kind}:${c.ref}`} variant="small">
                {`· ${t(`componentKind.${c.kind}`)} ${c.ref} — ${
                  t.has(`report.reason.${c.reason}`) ? t(`report.reason.${c.reason}`) : c.reason
                }`}
              </Text>
            ))}
          </Stack>
        </Stack>
      </Card>
    </section>
  );
}
