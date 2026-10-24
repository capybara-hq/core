"use client";

import { Button, Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Link, useRouter } from "../i18n/navigation";
import { issueLines } from "../lib/api";
import { installCatalogItem, type OrgCatalogItem, requestCatalogItem } from "../lib/catalog";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

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
 * - installed: shows the version (plugins also link to "Installed plugins"); a pending request: says
 *   who it is waiting for;
 * - `disabled` / `not_deployed`: only the reason, no button;
 * - org admins: `yes` / `granted` install (skills and extensions directly, connector templates and
 *   plugins through the install wizard); `needs_approval` asks an enterprise admin (the install call
 *   returns 202 and creates a request);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();

  const run = async (op: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    try {
      toast.success(await op());
      onChanged();
    } catch (e) {
      setError({ message: errorMessage(e), extra: issueLines(e) });
    } finally {
      setBusy(false);
    }
  };

  const install = () =>
    run(async () => {
      const r = await installCatalogItem(orgId, item.id, {});
      return "request" in r ? t("approvalRequested") : t("installed", { name: item.name });
    });
  const request = () =>
    run(async () => {
      await requestCatalogItem(orgId, item.id, "");
      return t("requested");
    });
  const wizard = item.kind === "connector-template" || item.kind === "app";

  let body: ReactNode;
  if (item.installed !== null) {
    body =
      item.kind === "app" ? (
        <Link href="/settings/plugins">{t("openPlugins")}</Link>
      ) : (
        <Text tone="ok">{`✓ ${item.installed.version}`}</Text>
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
      <Button loading={busy} disabled={busy} onClick={() => void install()}>
        {t("requestApproval")}
      </Button>
    );
  } else {
    body = (
      <Button
        variant="primary"
        loading={busy}
        disabled={busy}
        onClick={() => (wizard ? router.push(`/catalog/${item.id}/install`) : void install())}
      >
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
