"use client";

import {
  Button,
  Card,
  Dialog,
  formatDateTime,
  ImpactPreview,
  ItemList,
  ItemListItem,
  Stack,
  Subsection,
  Text,
  useTimeZone,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import { type PluginInstall, type UninstallReport, uninstallPlugin } from "../lib/catalog";
import { pluginChangeKeys } from "../lib/query/catalog";
import { retryOnMountOf } from "../lib/query/client";
import { useAppMutation } from "../lib/query/mutation";
import { pluginInstallsQuery } from "../lib/query/settings";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * The org's installs of one plugin on its 插件 detail page (org admins; formerly the settings page
 * "Installed plugins"): each lists its status and components (created by the install / existing; a
 * dependency install is a `plugin` component, shown by its plugin name); a plugin installed as a
 * dependency says which plugins use it. Upgrades (spec §10): "upgrade available" (or, when the
 * deployment runs another version of the plugin's extension, "upgrade this org's plugin") opens the
 * upgrade dialog (preview, inputs, confirm with the preview's diffHash); a component an upgrade
 * dropped but kept is marked. A failed or interrupted install can be cleaned up (an uninstall), after
 * which the `UninstallReport` shows what was removed, what was kept and why; a healthy install is
 * switched off with 停用 (the switch-off preview). A section: nothing while the installs load or
 * when they failed. An upgrade or a clean-up invalidates what a plugin change touches.
 */
export function PluginInstallsSection({ orgId, itemId }: { orgId: string; itemId: string }) {
  const tp = useTranslations("plugins.detail");
  const q = pluginInstallsQuery(orgId);
  const installs = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data?.installs;
  const [report, setReport] = useState<{
    name: string;
    report: UninstallReport;
    refName(c: Component): string;
  } | null>(null);
  if (installs === undefined) return null;
  const mine = installs.filter((i) => i.itemId === itemId);
  if (mine.length === 0 && report === null) return null;
  return (
    <Stack gap={12}>
      <Text variant="small" tone="muted">
        {tp("installs")}
      </Text>
      {report !== null && (
        <ReportCard
          name={report.name}
          report={report.report}
          refName={report.refName}
          onDismiss={() => setReport(null)}
        />
      )}
      {mine.map((a) => (
        <InstallCard
          key={a.id}
          orgId={orgId}
          install={a}
          refName={refNameIn(installs)}
          usedBy={installs
            .filter((o) => o.components.some((c) => c.kind === "plugin" && c.ref === a.id))
            .map((o) => o.name)}
          onUninstalled={(r) => {
            // The names of dependency installs are read before the list reloads without them
            setReport({ name: a.name, report: r, refName: refNameIn(installs) });
          }}
        />
      ))}
    </Stack>
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
  onUninstalled,
}: {
  orgId: string;
  install: PluginInstall;
  refName(c: Component): string;
  /** The plugins that installed this one as a dependency. */
  usedBy: string[];
  onUninstalled(r: UninstallReport): void;
}) {
  const timeZone = useTimeZone();
  const t = useTranslations("catalog.plugins");
  const ti = useTranslations("catalog.org.install.step");
  const errorMessage = useErrorMessage();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const broken = install.status === "failed" || install.status === "installing";
  // An uninstall removes what the plugin brought: everything a plugin change touches is read again.
  const remove = useAppMutation({
    fn: (installId: string) => uninstallPlugin(orgId, installId),
    invalidates: () => pluginChangeKeys(orgId),
  });

  const uninstall = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await remove.mutateAsync(install.id);
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
    <section aria-label={`${install.name} ${versionLabel(install.version)}`}>
      <Card
        title={`${install.name} ${versionLabel(install.version)}`}
        tone={install.status === "failed" ? "danger" : "default"}
        actions={
          <Stack direction="row" gap={8}>
            {broken && (
              <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
                {t("cleanup")}
              </Button>
            )}
          </Stack>
        }
      >
        <Stack gap={8}>
          <Text tone={install.status === "failed" ? "fail" : "muted"}>
            {`${t(`status.${install.status}`)} · ${t("installedAt", { at: formatDateTime(install.installedAt, "full", timeZone) })}`}
          </Text>
          {install.deploymentPending && <Text tone="warn">{t("deploymentPending")}</Text>}
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
            <Subsection title={t("components")} count={install.components.length}>
              <ItemList label={t("components")}>
                {install.components.map((c) => (
                  <ItemListItem
                    key={`${c.kind}:${c.ref}`}
                    title={refName(c)}
                    code={t(`componentKind.${c.kind}`)}
                    meta={
                      <Text variant="small" tone="muted">
                        {c.dropped ? t("dropped") : c.created ? t("created") : t("existing")}
                      </Text>
                    }
                  />
                ))}
              </ItemList>
            </Subsection>
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
          <Text variant="prose">{t("confirm.hint")}</Text>
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
        <ImpactPreview
          empty={t("report.nothing")}
          groups={[
            {
              id: "removed",
              title: t("report.removed"),
              items: report.removed.map((c) => ({
                id: `${c.kind}:${c.ref}`,
                title: refName(c),
                code: t(`componentKind.${c.kind}`),
              })),
              empty: t("report.noneRemoved"),
            },
            {
              id: "kept",
              title: t("report.kept"),
              items: report.kept.map((c) => ({
                id: `${c.kind}:${c.ref}`,
                title: refName(c),
                code: t(`componentKind.${c.kind}`),
                notes: [
                  {
                    text: t.has(`report.reason.${c.reason}`)
                      ? t(`report.reason.${c.reason}`)
                      : c.reason,
                  },
                ],
              })),
              empty: t("report.noneKept"),
            },
          ]}
        />
      </Card>
    </section>
  );
}
