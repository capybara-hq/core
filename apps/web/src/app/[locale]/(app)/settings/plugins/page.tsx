"use client";

import { Button, Card, Dialog, SettingsPage, Skeleton, Stack, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatTime } from "../../../../../components/ApprovalCard";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { PluginUpgradeDialog } from "../../../../../components/PluginUpgradeDialog";
import { useSettingsNav } from "../../../../../components/settings-nav";
import { ApiClientError } from "../../../../../lib/api";
import {
  listPluginInstalls,
  type PluginInstall,
  type UninstallReport,
  uninstallPlugin,
} from "../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/plugins`: the plugins this org installed from the catalog (SettingsPage,
 * admins). Each lists its status and components (created by the install / existing; a dependency
 * install is a `plugin` component, shown by its plugin name) and can be uninstalled (a failed or
 * interrupted install can be "cleaned up"); a plugin installed as a dependency says which plugins
 * use it. After an uninstall the `UninstallReport` shows what was removed, what was kept and why.
 * An install still in progress (`plugin.install_in_progress`) gets a friendly explanation.
 * Upgrades (spec §10): "upgrade available" (or, when the deployment runs another version of the
 * plugin's extension, "upgrade this org's plugin") opens the upgrade dialog (preview, inputs,
 * confirm with the preview's diffHash); a component an upgrade dropped but kept is marked.
 */
export default function PluginsPage() {
  return <OrgGate>{(orgId) => <Apps key={orgId} orgId={orgId} />}</OrgGate>;
}

function Apps({ orgId }: { orgId: string }) {
  const t = useTranslations("catalog.plugins");
  const nav = useSettingsNav();
  const errorMessage = useErrorMessage();
  const { state, reload } = useLoad(
    () => listPluginInstalls(orgId).then((r) => r.installs),
    [orgId],
  );
  const [report, setReport] = useState<{
    name: string;
    report: UninstallReport;
    refName(c: Component): string;
  } | null>(null);
  const installs = state.kind === "ready" ? state.data : [];
  return (
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="plugins">
      <Stack gap={16}>
        {report !== null && (
          <ReportCard
            name={report.name}
            report={report.report}
            refName={report.refName}
            onDismiss={() => setReport(null)}
          />
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
              refName={refNameIn(installs)}
              usedBy={installs
                .filter((o) => o.components.some((c) => c.kind === "plugin" && c.ref === a.id))
                .map((o) => o.name)}
              onUpgraded={reload}
              onUninstalled={(r) => {
                // The names of dependency installs are read before the list reloads without them
                setReport({ name: a.name, report: r, refName: refNameIn(installs) });
                reload();
              }}
            />
          ))
        )}
      </Stack>
    </SettingsPage>
  );
}

type Component = { kind: PluginInstall["components"][number]["kind"]; ref: string };

/** A component's name: a dependency install (`plugin`) by its plugin name, others by their ref. */
const refNameIn =
  (installs: PluginInstall[]) =>
  (c: Component): string =>
    c.kind === "plugin" ? (installs.find((i) => i.id === c.ref)?.name ?? c.ref) : c.ref;

function InstallCard({
  orgId,
  install,
  refName,
  usedBy,
  onUpgraded,
  onUninstalled,
}: {
  orgId: string;
  install: PluginInstall;
  refName(c: Component): string;
  /** The plugins that installed this one as a dependency. */
  usedBy: string[];
  onUpgraded(): void;
  onUninstalled(r: UninstallReport): void;
}) {
  const t = useTranslations("catalog.plugins");
  const ti = useTranslations("catalog.org.install.step");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const [confirm, setConfirm] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const broken = install.status === "failed" || install.status === "installing";
  const target = install.status === "installed" ? install.upgradeAvailable : null;

  const uninstall = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await uninstallPlugin(orgId, install.id);
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
    <section aria-label={`${install.name} ${install.version}`}>
      <Card
        title={`${install.name} ${install.version}`}
        tone={install.status === "failed" ? "danger" : "default"}
        actions={
          <Stack direction="row" gap={8}>
            {target !== null && (
              <Button disabled={busy} onClick={() => setUpgrading(true)}>
                {t("upgrade")}
              </Button>
            )}
            <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
              {broken ? t("cleanup") : t("uninstall")}
            </Button>
          </Stack>
        }
      >
        <Stack gap={8}>
          <Text tone={install.status === "failed" ? "fail" : "muted"}>
            {`${t(`status.${install.status}`)} · ${t("installedAt", { at: formatTime(install.installedAt, locale) })}`}
          </Text>
          {install.deploymentPending ? (
            <Text tone="warn">{t("deploymentPending")}</Text>
          ) : (
            target !== null && (
              <Text tone="accent">{t("upgradeAvailable", { version: target })}</Text>
            )
          )}
          {usedBy.length > 0 && (
            <Text variant="small" tone="muted">
              {t("dependencyOf", { names: usedBy.join(", ") })}
            </Text>
          )}
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
                  {`· ${t(`componentKind.${c.kind}`)} ${refName(c)} — ${
                    c.dropped ? t("dropped") : c.created ? t("created") : t("existing")
                  }`}
                </Text>
              ))}
            </Stack>
          )}
          {error !== undefined && <FormError message={error} />}
        </Stack>
        {target !== null && (
          <PluginUpgradeDialog
            orgId={orgId}
            install={install}
            target={target}
            open={upgrading}
            onOpenChange={setUpgrading}
            onDone={onUpgraded}
          />
        )}
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
    </section>
  );
}

/** The uninstall report: what was removed, what was kept and why. */
function ReportCard({
  name,
  report,
  refName,
  onDismiss,
}: {
  name: string;
  report: UninstallReport;
  refName(c: Component): string;
  onDismiss(): void;
}) {
  const t = useTranslations("catalog.plugins");
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
                {`− ${t(`componentKind.${c.kind}`)} ${refName(c)}`}
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
                {`· ${t(`componentKind.${c.kind}`)} ${refName(c)} — ${
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
