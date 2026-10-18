"use client";

import { Button, type Column, DataTable, SettingsPage, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatTime } from "../../../../../components/ApprovalCard";
import { OrgGate } from "../../../../../components/OrgGate";
import { usePersonalSettingsNav } from "../../../../../components/settings-nav";
import { listToolGrants, revokeToolGrant, type ToolGrant } from "../../../../../lib/approvals";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/** `/[locale]/settings/grants`：本人「以后都允许」的授权（SettingsPage），可逐条撤销。 */
export default function GrantsPage() {
  return <OrgGate>{(orgId) => <Grants orgId={orgId} />}</OrgGate>;
}

const keyOf = (g: ToolGrant) => `${g.agentId}/${g.toolKey}`;

function Grants({ orgId }: { orgId: string }) {
  const t = useTranslations("connections");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = usePersonalSettingsNav();
  const { state, reload } = useLoad(() => listToolGrants(orgId).then((r) => r.grants), [orgId]);
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
          size={24}
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
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="grants">
      <DataTable<ToolGrant>
        label={t("nav.grants")}
        columns={columns}
        rows={state.kind === "ready" ? state.data : []}
        rowKey={keyOf}
        state={state.kind === "ready" ? "ready" : state.kind}
        {...(state.kind === "error" ? { error: { code: state.code, onRetry: reload } } : {})}
        empty={{ title: t("grants.empty"), hint: t("grants.emptyHint") }}
      />
    </SettingsPage>
  );
}
