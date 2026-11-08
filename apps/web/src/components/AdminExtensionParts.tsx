"use client";

import { StatusMark } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ExtensionStatus } from "../lib/admin-extensions";

/** 部署级插件状态 → 状态标记的样式（文案另给）。 */
const MARK: Record<ExtensionStatus, "success" | "cancelled" | "failed" | "running" | "waiting"> = {
  enabled: "success",
  disabled: "cancelled",
  pending_approval: "waiting",
  pending_config: "waiting",
  pending_migration: "running",
  converging: "running",
  failed: "failed",
  dependency: "failed",
  conflict: "waiting",
  legacy_format: "failed",
};

/** Admin extension status (shared by the list and the detail page header). */
export function ExtensionStatusMark({
  status,
  orgsNeedingConfig,
}: {
  status: ExtensionStatus;
  /**
   * Orgs that must configure an overridable field the platform left empty: an enabled extension
   * then reads 运行中 · 组织需各自配置 with the count, not as a problem (spec A §5.4a).
   */
  orgsNeedingConfig?: number | undefined;
}) {
  const t = useTranslations("admin.extensions.status");
  if (status === "enabled" && orgsNeedingConfig !== undefined && orgsNeedingConfig > 0)
    return (
      <StatusMark
        status="success"
        label={t("runningOrgsConfigure", { count: orgsNeedingConfig })}
      />
    );
  return <StatusMark status={MARK[status]} label={t(status)} />;
}
