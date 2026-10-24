"use client";

import { Button, Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Link, useRouter } from "../i18n/navigation";
import { issueLines } from "../lib/api";
import { installDirectoryItem, type OrgDirectoryItem, requestDirectoryItem } from "../lib/catalog";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** 组织视角的状态文案（列表的状态列与详情页共用）。 */
export function useOrgItemStatus(): (item: OrgDirectoryItem) => string {
  const t = useTranslations("directory.org.status");
  return (item) => {
    if (item.installed !== null) return t("installed", { version: item.installed.version });
    if (item.request?.status === "pending") return t("requested");
    return t(item.installable);
  };
}

/**
 * 按 `installable` 给出的操作（只是界面上的分流，最终由内核判定）：
 * - 已安装：显示版本（应用另给「已安装的应用」链接）；已有待处理的申请：说明在等谁处理；
 * - `disabled` / `not_deployed`：只说明原因，没有按钮；
 * - 组织管理员：`yes` / `granted` 安装（技能与插件直接装，连接器模板与应用进安装向导）；`needs_approval` 申请企业管理员批准
 *   （安装接口返回 202 并建申请）；
 * - 成员：可装的条目「申请安装」（进组织管理员收件箱）。
 */
export function DirectoryInstallAction({
  orgId,
  item,
  admin,
  onChanged,
}: {
  orgId: string;
  item: OrgDirectoryItem;
  admin: boolean;
  onChanged(): void;
}) {
  const t = useTranslations("directory.org.action");
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
      const r = await installDirectoryItem(orgId, item.id, {});
      return "request" in r ? t("approvalRequested") : t("installed", { name: item.name });
    });
  const request = () =>
    run(async () => {
      await requestDirectoryItem(orgId, item.id, "");
      return t("requested");
    });
  const wizard = item.kind === "connector-template" || item.kind === "app";

  let body: ReactNode;
  if (item.installed !== null) {
    body =
      item.kind === "app" ? (
        <Link href="/settings/apps">{t("openApps")}</Link>
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
        onClick={() => (wizard ? router.push(`/directory/${item.id}/install`) : void install())}
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
