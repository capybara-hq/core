"use client";

import { StatusMark } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { PluginStatus } from "../lib/admin-plugins";

/** 部署级插件状态 → 状态标记的样式（文案另给）。 */
const MARK: Record<PluginStatus, "success" | "cancelled" | "failed" | "running" | "waiting"> = {
  enabled: "success",
  disabled: "cancelled",
  pending_approval: "waiting",
  pending_config: "waiting",
  pending_migration: "running",
  converging: "running",
  failed: "failed",
  dependency: "failed",
};

/** 后台插件状态（列表与详情页头共用）。 */
export function PluginStatusMark({ status }: { status: PluginStatus }) {
  const t = useTranslations("admin.plugins.status");
  return <StatusMark status={MARK[status]} label={t(status)} />;
}
