"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Link, useRouter } from "../i18n/navigation";
import { type Agent, listAgents } from "../lib/agents";
import { createConversation } from "../lib/conversations";
import { useErrorMessage } from "../lib/use-error-message";

/** 当前组织中可见的 agent；「开始对话」新建会话并进入聊天页。 */
export function AgentList({ orgId }: { orgId: string }) {
  const t = useTranslations("agents");
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>();
  const [starting, setStarting] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    listAgents(orgId).then(
      (r) => {
        if (!disposed) setAgents(r.agents);
      },
      (e: unknown) => {
        if (!disposed) setError(errorMessage(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, errorMessage]);

  async function onStart(agentId: string) {
    setStarting(agentId);
    setError(undefined);
    try {
      const { conversation } = await createConversation(orgId, agentId);
      router.push(`/chat/${encodeURIComponent(conversation.id)}`);
    } catch (e) {
      setError(errorMessage(e));
      setStarting(undefined);
    }
  }

  return (
    <div className="card wide">
      <div className="row">
        <h1>{t("title")}</h1>
        <Link href="/agents/new">{t("new")}</Link>
      </div>
      {error !== undefined && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {agents !== undefined && agents.length === 0 && <p>{t("empty")}</p>}
      {agents !== undefined && agents.length > 0 && (
        <ul className="agents">
          {agents.map((a) => (
            <li key={a.id} className="row">
              <div>
                <strong>{a.definition.name}</strong>
                <br />
                <small>
                  {t("modelLine", {
                    provider: a.definition.model.provider,
                    model: a.definition.model.model,
                  })}
                </small>
              </div>
              <button
                type="button"
                onClick={() => void onStart(a.id)}
                disabled={starting !== undefined}
              >
                {starting === a.id ? t("starting") : t("startChat")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Link href="/">{t("backHome")}</Link>
    </div>
  );
}
