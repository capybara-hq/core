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
};

/** Admin extension status (shared by the list and the detail page header). */
export function ExtensionStatusMark({ status }: { status: ExtensionStatus }) {
  const t = useTranslations("admin.extensions.status");
  return <StatusMark status={MARK[status]} label={t(status)} />;
}
