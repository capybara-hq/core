"use client";

import {
  Button,
  Card,
  Dialog,
  formatDateTime,
  SettingsPage,
  Stack,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { PluginUpgradeDialog } from "../../../../components/PluginUpgradeDialog";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { ApiClientError } from "../../../../lib/api";
import { type PluginInstall, type UninstallReport, uninstallPlugin } from "../../../../lib/catalog";
import { pluginChangeKeys } from "../../../../lib/query/catalog";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { pluginInstallsQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/plugins`: the plugins this org installed from the catalog (SettingsPage,
 * admins). Each lists its status and components (created by the install / existing; a dependency
 * install is a `plugin` component, shown by its plugin name) and can be uninstalled (a failed or
 * interrupted install can be "cleaned up"); a plugin installed as a dependency says which plugins
 * use it. After an uninstall the `UninstallReport` shows what was removed, what was kept and why.
 * An install still in progress (`plugin.install_in_progress`) gets a friendly explanation.
 * Upgrades (spec §10): "upgrade available" (or, when the deployment runs another version of the
 * plugin's extension, "upgrade this org's plugin") opens the upgrade dialog (preview, inputs,
 * confirm with the preview's diffHash); a component an upgrade dropped but kept is marked.
 * From the query cache (the layout prefetched it on a first load); an upgrade or uninstall
 * invalidates what a plugin change touches (the installs among them).
 */
export default function PluginsView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Apps orgId={ws.orgId} />;
}

function Apps({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("catalog.plugins");
  const nav = useOrgSettingsNav();
  const read = usePageQuery(pluginInstallsQuery(orgId));
  const [report, setReport] = useState<{
    name: string;
    report: UninstallReport;
    refName(c: Component): string;
  } | null>(null);
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <SettingsPage
        header={{
          path: [
            ...scope,
            { label: "settings", href: "/settings/organization" },
            { label: "plugins" },
          ],
          title: t("title"),
        }}
        nav={nav}
        activeNav="plugins"
        // The install cards (the template's default count): a status line, the components list
        // (its label and two components, the typical count) and the uninstall button.
        loading={{ cards: { shape: { lines: 1, list: 2, actions: 1 } } }}
      />
    );
  }
  const installs = read.data.installs;
  return (
    <SettingsPage
      header={{
        path: [
          ...scope,
          { label: "settings", href: "/settings/organization" },
          { label: "plugins" },
        ],
        title: t("title"),
      }}
      nav={nav}
      activeNav="plugins"
    >
      <Stack gap={16}>
        {report !== null && (
          <ReportCard
            name={report.name}
            report={report.report}
            refName={report.refName}
            onDismiss={() => setReport(null)}
          />
        )}
        {installs.length === 0 ? (
          <Text tone="muted">{t("empty")}</Text>
        ) : (
          installs.map((a) => (
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
  onUninstalled,
}: {
  orgId: string;
  install: PluginInstall;
  refName(c: Component): string;
  /** The plugins that installed this one as a dependency. */
  usedBy: string[];
  onUninstalled(r: UninstallReport): void;
}) {
  const t = useTranslations("catalog.plugins");
  const ti = useTranslations("catalog.org.install.step");
  const errorMessage = useErrorMessage();
  const [confirm, setConfirm] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const broken = install.status === "failed" || install.status === "installing";
  const target = install.status === "installed" ? install.upgradeAvailable : null;
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
            {`${t(`status.${install.status}`)} · ${t("installedAt", { at: formatDateTime(install.installedAt) })}`}
          </Text>
          {install.deploymentPending ? (
            <Text tone="warn">{t("deploymentPending")}</Text>
          ) : (
            target !== null && (
              <Text tone="accent">{t("upgradeAvailable", { version: versionLabel(target) })}</Text>
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
