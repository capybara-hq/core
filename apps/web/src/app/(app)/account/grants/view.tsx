"use client";

import {
  Button,
  type Column,
  DataTable,
  DateTime,
  SettingsPage,
  useToast,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { ACCOUNT_HOME, useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { revokeToolGrant, type ToolGrant } from "../../../../lib/approvals";
import { toolGrantsQuery } from "../../../../lib/query/account";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { toolLabelOfKey, toolLabelText } from "../../../../lib/tool-label";
import { useErrorMessage } from "../../../../lib/use-error-message";

/**
 * `/account/grants`：本人「以后都允许」的授权（SettingsPage），可逐条撤销。From the query cache (the
 * layout prefetched it on a first load); a revoke invalidates the grants, which are read again.
 */
const keyOf = (g: ToolGrant) => `${g.agentId}/${g.toolKey}`;
const labelOf = (g: ToolGrant) => toolLabelText(toolLabelOfKey(g.toolKey));

export default function GrantsView() {
  const ws = useWorkspace({ setup: "step" });
  if (ws.kind !== "ok") return null;
  return <Grants orgId={ws.orgId} />;
}

function Grants({ orgId }: { orgId: string }) {
  const scope = usePagePath("home");
  const t = useTranslations("connections");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useAccountNav();
  const read = usePageQuery(toolGrantsQuery(orgId));
  const qc = useQueryClient();
  const retry = () => void qc.refetchQueries({ queryKey: toolGrantsQuery(orgId).queryKey });
  const [revoking, setRevoking] = useState<string>();
  const revokeGrant = useAppMutation({
    fn: (g: ToolGrant) => revokeToolGrant(orgId, g.agentId, g.toolKey),
    invalidates: () => [keys.org(orgId).toolGrants()],
  });

  async function revoke(g: ToolGrant) {
    setRevoking(keyOf(g));
    try {
      await revokeGrant.mutateAsync(g);
      toast.success(t("grants.revoked", { tool: labelOf(g) }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRevoking(undefined);
    }
  }

  const columns: Column<ToolGrant>[] = [
    { key: "agent", header: t("grants.columns.agent"), cell: (g) => g.agentName },
    { key: "tool", header: t("grants.columns.tool"), cell: labelOf },
    // the raw key stays as secondary text
    { key: "key", header: t("grants.columns.key"), tone: "muted", cell: (g) => g.toolKey },
    {
      key: "created",
      header: t("grants.columns.created"),
      tone: "muted",
      cell: (g) => <DateTime value={g.createdAt} />,
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
          aria-label={t("grants.revokeLabel", { tool: labelOf(g), agent: g.agentName })}
          onClick={() => void revoke(g)}
        >
          {t("grants.revoke")}
        </Button>
      ),
    },
  ];

  // A 404 of my own list is no missing object: it is an error with a retry, like any failure.
  if (read.kind === "notFound") return <ErrorFrame reset={retry} />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return (
    <SettingsPage
      header={{
        path: [...scope, { label: "account", href: ACCOUNT_HOME }, { label: "grants" }],
        title: t("nav.grants"),
      }}
      nav={nav}
      activeNav="grants"
    >
      <DataTable<ToolGrant>
        label={t("nav.grants")}
        columns={columns}
        rows={read.kind === "ready" ? read.data.grants : []}
        rowKey={keyOf}
        state={read.kind === "ready" ? "ready" : "loading"}
        empty={{ title: t("grants.empty"), hint: t("grants.emptyHint") }}
      />
    </SettingsPage>
  );
}
