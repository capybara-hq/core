"use client";

import { Button, Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Link, useRouter } from "../i18n/navigation";
import { issueLines } from "../lib/api";
import { installCatalogItem, type OrgCatalogItem, requestCatalogItem } from "../lib/catalog";
import { useErrorMessage } from "../lib/use-error-message";
import { useCatalogErrorLines } from "./CatalogParts";
import { FormError } from "./form-error";
import { PluginUpgradeDialog } from "./PluginUpgradeDialog";

/** Status copy from the org's view (shared by the list's status column and the detail page). */
export function useOrgItemStatus(): (item: OrgCatalogItem) => string {
  const t = useTranslations("catalog.org.status");
  return (item) => {
    if (item.installed !== null) return t("installed", { version: item.installed.version });
    if (item.request?.status === "pending") return t("requested");
    return t(item.installable);
  };
}

/**
 * The action offered by `installable` (only a UI split; the kernel decides):
 * - installed: the version (org admins also get a link to "Installed plugins"); with
 *   `upgradeAvailable` the version it can move to, and org admins an "Upgrade" (the upgrade dialog:
 *   preview, inputs, confirm); a pending request:
 *   says who it is waiting for;
 * - `disabled` / `not_deployed`: only the reason, no button;
 * - org admins: `yes` / `granted` open the install wizard (it lists what the plugin brings,
 *   dependencies included, and asks for template input and the extension's org config);
 *   `needs_approval` asks an enterprise admin (the install call returns 202 and creates a request);
 * - members: "Request install" for installable items (goes to the org admins' inbox).
 */
export function CatalogInstallAction({
  orgId,
  item,
  admin,
  onChanged,
}: {
  orgId: string;
  item: OrgCatalogItem;
  admin: boolean;
  onChanged(): void;
}) {
  const t = useTranslations("catalog.org.action");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const [upgrading, setUpgrading] = useState(false);

  const run = async (op: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    try {
      toast.success(await op());
      onChanged();
    } catch (e) {
      setError({ message: errorMessage(e), extra: [...issueLines(e), ...catalogLines(e)] });
    } finally {
      setBusy(false);
    }
  };

  const askApproval = () =>
    run(async () => {
      const r = await installCatalogItem(orgId, item.id, {});
      return "request" in r ? t("approvalRequested") : t("installed", { name: item.name });
    });
  const request = () =>
    run(async () => {
      await requestCatalogItem(orgId, item.id, "");
      return t("requested");
    });

  let body: ReactNode;
  const installed = item.installed;
  if (installed !== null) {
    const target = installed.upgradeAvailable;
    body = (
      <>
        <Text tone="ok">{`✓ ${installed.version}`}</Text>
        {target !== null && <Text tone="accent">{t("upgradeAvailable", { version: target })}</Text>}
        {admin && target !== null && (
          <>
            <Button onClick={() => setUpgrading(true)}>{t("upgrade")}</Button>
            <PluginUpgradeDialog
              orgId={orgId}
              install={{ id: installed.pluginInstallId, name: item.name }}
              target={target}
              open={upgrading}
              onOpenChange={setUpgrading}
              onDone={onChanged}
            />
          </>
        )}
        {admin && <Link href="/settings/plugins">{t("openPlugins")}</Link>}
      </>
    );
  } else if (item.request?.status === "pending") {
    body = (
      <Text tone="muted">{t("pendingHint", { stage: t(`stage.${item.request.stage}`) })}</Text>
    );
  } else if (item.installable === "disabled") {
    body = <Text tone="muted">{t("disabledHint")}</Text>;
  } else if (item.installable === "not_deployed") {
    body = <Text tone="warn">{t("notDeployedHint")}</Text>;
  } else if (!admin) {
    body = (
      <Button loading={busy} disabled={busy} onClick={() => void request()}>
        {t("request")}
      </Button>
    );
  } else if (item.installable === "needs_approval") {
    body = (
      <Button loading={busy} disabled={busy} onClick={() => void askApproval()}>
        {t("requestApproval")}
      </Button>
    );
  } else {
    body = (
      <Button variant="primary" onClick={() => router.push(`/catalog/${item.id}/install`)}>
        {t("install")}
      </Button>
    );
  }
  return (
    <Stack gap={4}>
      <Stack direction="row" gap={8} align="center">
        {body}
      </Stack>
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
    </Stack>
  );
}
