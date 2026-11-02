"use client";

import { Button, type Column, DataTable, SettingsPage, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { formatTime } from "../../../../components/ApprovalCard";
import { useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import { revokeToolGrant, type ToolGrant } from "../../../../lib/approvals";
import { useErrorMessage } from "../../../../lib/use-error-message";

/**
 * `/account/grants`：本人「以后都允许」的授权（SettingsPage），可逐条撤销。Read on the server
 * (`page.tsx`); a revoke re-renders the page there.
 */
const keyOf = (g: ToolGrant) => `${g.agentId}/${g.toolKey}`;

export default function Grants({ orgId, initial }: { orgId: string; initial: ToolGrant[] }) {
  const scope = usePagePath("home");
  const t = useTranslations("connections");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useAccountNav();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const reload = () => startTransition(() => router.refresh());
  const [revoking, setRevoking] = useState<string>();

  async function revoke(g: ToolGrant) {
    setRevoking(keyOf(g));
    try {
      await revokeToolGrant(orgId, g.agentId, g.toolKey);
      toast.success(t("grants.revoked", { tool: g.toolKey }));
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRevoking(undefined);
    }
  }

  const columns: Column<ToolGrant>[] = [
    { key: "agent", header: t("grants.columns.agent"), cell: (g) => g.agentName },
    { key: "tool", header: t("grants.columns.tool"), cell: (g) => g.toolKey },
    {
      key: "created",
      header: t("grants.columns.created"),
      tone: "muted",
      cell: (g) => formatTime(g.createdAt, locale),
    },
    {
      key: "actions",
      header: t("grants.columns.actions"),
      align: "right",
      cell: (g) => (
        <Button
          density="dense"
          variant="danger"
          loading={revoking === keyOf(g)}
          disabled={revoking !== undefined}
          aria-label={t("grants.revokeLabel", { tool: g.toolKey, agent: g.agentName })}
          onClick={() => void revoke(g)}
        >
          {t("grants.revoke")}
        </Button>
      ),
    },
  ];

  return (
    <SettingsPage
      header={{
        path: [...scope, { label: "account", href: "/account/connections" }, { label: "grants" }],
        title: t("nav.grants"),
      }}
      nav={nav}
      activeNav="grants"
    >
      <DataTable<ToolGrant>
        label={t("nav.grants")}
        columns={columns}
        rows={initial}
        rowKey={keyOf}
        state="ready"
        empty={{ title: t("grants.empty"), hint: t("grants.emptyHint") }}
      />
    </SettingsPage>
  );
}
