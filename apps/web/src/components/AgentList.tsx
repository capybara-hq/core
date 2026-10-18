"use client";

import { Button, type Column, DataTable, useStatusBar, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { type Agent, listAgents } from "../lib/agents";
import { ApiClientError } from "../lib/api";
import { createConversation } from "../lib/conversations";
import { useErrorMessage } from "../lib/use-error-message";

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
 * Agent 列表（DataTable）：列为名称、模型；点击行 / 回车或行菜单「开始对话」新建会话并进入对话页，
 * 创建期间该行置灰、名称后显示进度，其余行不再响应。空状态带「新建 Agent」。
 */
export function AgentTable({
  orgId,
  agents,
}: {
  orgId: string;
  agents: ReturnType<typeof useAgents>;
}) {
  const t = useTranslations("agents");
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const toast = useToast();
  const [starting, setStarting] = useState<string>();
  useStatusBar(starting === undefined ? null : `· ${t("starting")}`);

  async function onStart(agentId: string) {
    if (starting !== undefined) return;
    setStarting(agentId);
    try {
      const { conversation } = await createConversation(orgId, agentId);
      router.push(`/chat/${encodeURIComponent(conversation.id)}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setStarting(undefined);
    }
  }

  const columns: Column<Agent>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (a) =>
        a.id === starting ? `${a.definition.name} · ${t("starting")}` : a.definition.name,
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
      framed={false}
      columns={columns}
      rows={agents.kind === "ready" ? agents.agents : []}
      rowKey={(a) => a.id}
      rowLabel={(a) => a.definition.name}
      onOpen={(a) => void onStart(a.id)}
      isDisabled={(a) => a.id === starting}
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
          disabled: starting !== undefined,
          onSelect: () => void onStart(a.id),
        },
      ]}
    />
  );
}
