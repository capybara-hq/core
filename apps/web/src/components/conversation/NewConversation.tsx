"use client";

import { type ConversationPageProps, Stack, Text, untitledLabel } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { createConversationWithMessage, type MessageInput } from "../../lib/conversations";
import { agentsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { modelsQuery, seedNewConversation } from "../../lib/query/conversation";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { conversationGroupsQuery } from "../../lib/query/shell";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { useSession } from "../shell/session";
import { ComposerBar, type ComposerDraft, type ComposerMessage } from "./ComposerBar";
import { useStatusSignature } from "./ConversationView";
import { PendingBubbles, usePendingSends } from "./PendingBubbles";
import type { SendResult } from "./useConversation";
import { useSelection } from "./useSelection";

/**
 * A new conversation (`/chat`, spec §5.2): an empty page with the composer, the agent picker
 * enabled. The agent is `?agent=` when usable, else the one most recently talked to, else the
 * first. Nothing is created before the first send: it posts `POST /conversations` with the message
 * (and any model / effort pick), then replaces the URL with the new conversation's. The agents,
 * the most recent agent (the sidebar's first group) and the models come from the query cache.
 *
 * The send is instant (conversation send spec §2.1): the page switches to the conversation layout
 * at once with the pending bubble and the working line; the create's answer seeds the new
 * conversation's cache, and the URL changes without waiting for the sidebar's groups. A failed
 * create goes back to the new conversation with the draft in the composer.
 */
export function useNewConversationPage(
  orgId: string,
  preferredAgent: string | null,
): ConversationPageProps {
  const t = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const session = useSession();
  const signature = useStatusSignature("/chat");
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data
    ?.agents;
  const groupsQ = conversationGroupsQuery(orgId);
  const groups = useQuery({ ...groupsQ, retryOnMount: retryOnMountOf(groupsQ.queryKey) });
  // A failed groups read leaves no recent agent: the first one is picked.
  const recent = groups.data?.groups[0]?.agent.id ?? null;
  const recentKnown = groups.data !== undefined || groups.error !== null;
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const usable = agents ?? [];
  // Until the recent agent is known, nothing is picked (the default would flip under the person).
  const agent =
    usable.find((a) => a.id === picked) ??
    usable.find((a) => a.id === preferredAgent) ??
    (recentKnown ? (usable.find((a) => a.id === recent) ?? usable[0]) : undefined);
  const modelsQ = modelsQuery(orgId);
  const providers = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) }).data
    ?.providers;
  // The answer seeds the new conversation's cache; the sidebar's groups are read again without
  // the navigation waiting for them (they show the new conversation when they land).
  const create = useAppMutation({
    fn: async (v: { agentId: string; message: MessageInput; sentAt: number }) => {
      const r = await createConversationWithMessage(orgId, v.agentId, v.message);
      seedNewConversation(qc, orgId, r.conversation, r, v.sentAt);
      return r;
    },
    invalidates: () => [],
  });
  const selection = useSelection(providers, agent, undefined);
  const pending = usePendingSends(undefined);
  /** A failed create's draft, for the composer the new layout mounts again. */
  const [restore, setRestore] = useState<{ n: number; draft?: ComposerDraft }>({ n: 0 });
  /** A second ↵ came before the conversation exists: the composer says why it waits. */
  const [blocked, setBlocked] = useState(false);

  const send = async (m: ComposerMessage): Promise<SendResult> => {
    if (!agent) return { ok: false, error: new Error("no agent") };
    setError(undefined);
    pending.add(m);
    try {
      const { conversation } = await create.mutateAsync({
        agentId: agent.id,
        message: { ...m, ...selection.pending },
        // this tab's clock at the send: the working line's backstop counts from it
        sentAt: Date.now(),
      });
      setBlocked(false);
      router.replace(`/chat/${encodeURIComponent(conversation.id)}`);
      void qc.invalidateQueries({ queryKey: keys.org(orgId).conversationGroupsAll() });
      return { ok: true };
    } catch (e) {
      setError(errorMessage(e));
      pending.drop(m.clientMessageId);
      setBlocked(false);
      setRestore((r) => ({ n: r.n + 1, ...(m.draft !== undefined ? { draft: m.draft } : {}) }));
      return { ok: false, error: e };
    }
  };

  const name = agent?.definition.name ?? "—";
  // Sent: the conversation layout, the pending bubble then the working line (spec §2.1).
  const sent = pending.shown.length > 0;
  return {
    titleBar: {
      title: null,
      untitled: sent ? untitledLabel(new Date(), locale) : "",
      menu: [],
      properties: { pressed: false, onToggle: () => {} },
      panels: [],
    },
    ...(sent
      ? { thread: <PendingBubbles items={pending.shown} />, working: true }
      : { newConversation: { agentName: name } }),
    composer: (
      <Stack gap={8}>
        {error !== undefined && <FormError message={error} />}
        {agents !== undefined && usable.length === 0 ? <FormError message={t("noAgents")} /> : null}
        {sent && blocked ? (
          <Text variant="small" tone="muted">
            {t("sendAfterCreate")}
          </Text>
        ) : null}
        <ComposerBar
          key={`${sent ? "sent" : "new"}:${restore.n}`}
          orgId={orgId}
          agentId={agent?.id}
          initialDraft={sent ? undefined : restore.draft}
          running={false}
          // one message at a time until the conversation exists (it has no queue yet)
          sendDisabled={!agent || sent}
          onBlocked={() => {
            if (sent) setBlocked(true);
          }}
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
    status: { ...signature, version: session.version ?? "" },
    right: "none",
    onCloseRight: () => {},
  };
}
