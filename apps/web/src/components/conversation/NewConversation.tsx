"use client";

import { type ConversationPageProps, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { createConversationWithMessage, listConversationGroups } from "../../lib/conversations";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { useSession } from "../shell/session";
import { ComposerBar, type ComposerMessage } from "./ComposerBar";
import { useAgentList, useWho } from "./ConversationView";
import type { SendResult } from "./useConversation";
import { useModels, useSelection } from "./useSelection";

/** The agent most recently talked to (the first sidebar group), or null. */
function useRecentAgent(orgId: string): string | null | undefined {
  const [recent, setRecent] = useState<string | null>();
  useEffect(() => {
    let live = true;
    listConversationGroups(orgId, { perGroup: 1, limit: 1 }).then(
      (r) => {
        if (live) setRecent(r.groups[0]?.agent.id ?? null);
      },
      () => {
        if (live) setRecent(null);
      },
    );
    return () => {
      live = false;
    };
  }, [orgId]);
  return recent;
}

/**
 * A new conversation (`/chat`, spec §5.2): an empty page with the composer, the agent picker
 * enabled. The agent is `?agent=` when usable, else the one most recently talked to, else the
 * first. Nothing is created before the first send: it posts `POST /conversations` with the message
 * (and any model / effort pick), then replaces the URL with the new conversation's.
 */
export function useNewConversationPage(
  orgId: string,
  preferredAgent: string | null,
): ConversationPageProps {
  const t = useTranslations("chat");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const session = useSession();
  const who = useWho();
  const agents = useAgentList(orgId);
  const recent = useRecentAgent(orgId);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const usable = agents ?? [];
  // Until the recent agent is known, nothing is picked (the default would flip under the person).
  const agent =
    usable.find((a) => a.id === picked) ??
    usable.find((a) => a.id === preferredAgent) ??
    (recent === undefined ? undefined : (usable.find((a) => a.id === recent) ?? usable[0]));
  const providers = useModels(orgId);
  const selection = useSelection(providers, agent, undefined);

  const send = async (m: ComposerMessage): Promise<SendResult> => {
    if (!agent) return { ok: false, error: new Error("no agent") };
    try {
      const { conversation } = await createConversationWithMessage(orgId, agent.id, {
        ...m,
        ...selection.pending,
      });
      router.replace(`/chat/${encodeURIComponent(conversation.id)}`);
      return { ok: true };
    } catch (e) {
      setError(errorMessage(e));
      return { ok: false, error: e };
    }
  };

  const name = agent?.definition.name ?? "—";
  return {
    titleBar: {
      title: null,
      untitled: "",
      menu: [],
      properties: { pressed: false, onToggle: () => {} },
      panels: [],
    },
    newConversation: { agentName: name },
    composer: (
      <Stack gap={8}>
        {error !== undefined && <FormError message={error} />}
        {agents !== undefined && usable.length === 0 ? <FormError message={t("noAgents")} /> : null}
        <ComposerBar
          orgId={orgId}
          running={false}
          sendDisabled={!agent}
          onSend={send}
          pickers={{
            agent: {
              label: t("pickAgent"),
              value: name,
              disabled: usable.length === 0,
              groups: [
                {
                  items: usable.map((a) => ({
                    id: a.id,
                    label: a.definition.name,
                    checked: a.id === agent?.id,
                  })),
                },
              ],
              note: t("agentLocked"),
              onPick: setPicked,
            },
            model: selection.modelPicker,
            ...(selection.effortPicker ? { effort: selection.effortPicker } : {}),
          }}
          placeholder={t("newPlaceholder", { agent: name })}
        />
      </Stack>
    ),
    status: { context: `${who}:/chat`, version: session.version ?? "" },
    right: "none",
    onCloseRight: () => {},
  };
}
