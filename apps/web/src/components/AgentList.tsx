"use client";

import { Button, type Column, DataTable } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { type Agent, listAgents } from "../lib/agents";
import { ApiClientError } from "../lib/api";
import { canUpdateOrg } from "../lib/org-settings";
import { SessionContext } from "./shell/session";

type AgentsState =
  | { kind: "loading" }
  | { kind: "ready"; agents: Agent[] }
  | { kind: "error"; code: string };

/** 当前组织中可见的 agent（`GET /orgs/:orgId/agents`）；`reload` 重新读取。 */
export function useAgents(orgId: string): AgentsState & { reload(): void } {
  const [state, setState] = useState<AgentsState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce 只用于触发重新读取
  useEffect(() => {
    let disposed = false;
    setState({ kind: "loading" });
    listAgents(orgId).then(
      (r) => {
        if (!disposed) setState({ kind: "ready", agents: r.agents });
      },
      (e: unknown) => {
        if (!disposed)
          setState({ kind: "error", code: e instanceof ApiClientError ? e.code : "unknown" });
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/**
 * The agents table: name and model; a row (click / Enter) or its menu "Start chat" opens a new
 * conversation with that agent picked (`/chat?agent=`), created on the first send.负责人与组织管理员的行菜单另有「编辑」
 * （界面上的隐藏，最终由内核判定）。空状态带「新建 Agent」。
 */
export function AgentTable({ agents }: { orgId: string; agents: ReturnType<typeof useAgents> }) {
  const t = useTranslations("agents");
  const router = useRouter();
  const session = useContext(SessionContext);
  const canEdit = (a: Agent) =>
    session !== null && (a.ownerAccountId === session.me.account.id || canUpdateOrg(session.me));
  // A new conversation with this agent picked: created on the first send (spec §5.2).
  function onStart(agentId: string) {
    router.push(`/chat?agent=${encodeURIComponent(agentId)}`);
  }

  const columns: Column<Agent>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (a) => a.definition.name,
    },
    {
      key: "model",
      header: t("columns.model"),
      tone: "muted",
      cell: (a) => `${a.definition.model.provider} / ${a.definition.model.model}`,
    },
  ];

  return (
    <DataTable<Agent>
      label={t("title")}
      columns={columns}
      rows={agents.kind === "ready" ? agents.agents : []}
      rowKey={(a) => a.id}
      rowLabel={(a) => a.definition.name}
      onOpen={(a) => onStart(a.id)}
      state={agents.kind === "ready" ? "ready" : agents.kind}
      {...(agents.kind === "error" ? { error: { code: agents.code, onRetry: agents.reload } } : {})}
      empty={{
        title: t("empty"),
        hint: t("emptyHint"),
        action: <Button onClick={() => router.push("/agents/new")}>{t("new")}</Button>,
      }}
      rowMenu={(a) => [
        {
          label: t("startChat"),
          onSelect: () => onStart(a.id),
        },
        ...(canEdit(a)
          ? [
              {
                label: t("edit"),
                onSelect: () => router.push(`/agents/${encodeURIComponent(a.id)}`),
              },
            ]
          : []),
      ]}
    />
  );
}
