"use client";

import {
  AgentRow,
  type AgentRowItem,
  type ConversationPageProps,
  Greeting,
  QuickActions,
  Stack,
  Text,
  untitledLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { type Agent, avatarValue } from "../../lib/agents";
import {
  type ConversationGroup,
  createConversationWithMessage,
  type MessageInput,
} from "../../lib/conversations";
import { type GreetingLines, greetingBucket, pickGreeting } from "../../lib/greeting";
import { canEditAgent } from "../../lib/org-settings";
import { agentsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { modelsQuery, seedNewConversation } from "../../lib/query/conversation";
import { environmentsQuery } from "../../lib/query/environments";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { conversationGroupsQuery } from "../../lib/query/shell";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { useSession } from "../shell/session";
import {
  ComposerBar,
  type ComposerControl,
  type ComposerDraft,
  type ComposerMessage,
} from "./ComposerBar";
import { useStatusSignature } from "./ConversationView";
import { PendingBubbles, usePendingSends } from "./PendingBubbles";
import type { SendResult } from "./useConversation";
import { useEnvironmentChoice, useSelection } from "./useSelection";

/**
 * The agents in the row's order: by this person's most recent conversation with each (the sidebar's
 * groups, most recent first), then by name. Returns the order and the ids that have a recent
 * conversation (the panel's 「最近用过」), most recent first.
 */
export function orderAgents(
  agents: Agent[],
  groups: readonly Pick<ConversationGroup, "agent">[],
  locale: string,
): { ordered: Agent[]; recent: string[] } {
  const usable = new Set(agents.map((a) => a.id));
  const recent: string[] = [];
  for (const g of groups) {
    if (usable.has(g.agent.id) && !recent.includes(g.agent.id)) recent.push(g.agent.id);
  }
  const rank = new Map(recent.map((id, i) => [id, i]));
  const ordered = [...agents].sort((a, b) => {
    const ra = rank.get(a.id) ?? Number.POSITIVE_INFINITY;
    const rb = rank.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.definition.name.localeCompare(b.definition.name, locale);
  });
  return { ordered, recent };
}

/**
 * A new conversation (`/chat`, spec §5.2, agent profile design §4): the greeting, the agents row,
 * the selected agent's quick actions and the composer (no agent picker: the row picks). The agent
 * is `?agent=` when usable, else the one most recently talked to, else the first in the row's
 * order. The greeting is picked after mount (the server draws its same-height placeholder, so the
 * first paint matches). A quick action fills the composer (one ⌘Z step brings the text back).
 * Nothing is created before the first send: it posts `POST /conversations` with the message (and
 * any model / effort pick), then replaces the URL with the new conversation's. The agents, the
 * most recent agent (the sidebar's first group) and the models come from the query cache.
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
  const { ordered: usable, recent: recentIds } = orderAgents(
    agents ?? [],
    groups.data?.groups ?? [],
    locale,
  );
  // Until the recent agent is known, nothing is picked (the default would flip under the person).
  const agent =
    usable.find((a) => a.id === picked) ??
    usable.find((a) => a.id === preferredAgent) ??
    (recentKnown ? (usable.find((a) => a.id === recent) ?? usable[0]) : undefined);
  const composer = useRef<ComposerControl>(null);
  /** The greeting line, picked in the browser after mount (null: the placeholder). */
  const [greeting, setGreeting] = useState<string | null>(null);
  const displayName = session.me.account.displayName;
  const lines = t.raw("greeting") as GreetingLines;
  // biome-ignore lint/correctness/useExhaustiveDependencies: picked once per mount, not per render
  useEffect(() => {
    setGreeting(pickGreeting(greetingBucket(new Date().getHours()), displayName, lines));
  }, []);
  const modelsQ = modelsQuery(orgId);
  const providers = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) }).data
    ?.providers;
  // The answer seeds the new conversation's cache; the sidebar's groups are read again without
  // the navigation waiting for them (they show the new conversation when they land).
  const create = useAppMutation({
    fn: async (v: {
      agentId: string;
      message: MessageInput;
      sentAt: number;
      environmentId: string | undefined;
    }) => {
      const r = await createConversationWithMessage(orgId, v.agentId, v.message, v.environmentId);
      seedNewConversation(qc, orgId, r.conversation, r, v.sentAt);
      return r;
    },
    invalidates: () => [],
  });
  const environmentsQ = environmentsQuery(orgId);
  const environments = useQuery({
    ...environmentsQ,
    retryOnMount: retryOnMountOf(environmentsQ.queryKey),
  }).data;
  const environment = useEnvironmentChoice(environments);
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
        environmentId: environment.environmentId,
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
  const rowItems: AgentRowItem[] = usable.map((a) => ({
    id: a.id,
    name: a.definition.name,
    description: a.profile.description,
    avatar: avatarValue(a, orgId),
  }));
  const quickActions = agent?.profile.quickActions ?? [];
  const selectAgent = (id: string) => {
    setPicked(id);
    composer.current?.focus();
  };
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
      : {
          newConversation: {
            greeting: <Greeting text={greeting} sub={t("greeting.sub")} />,
            agents: (
              <AgentRow
                agents={rowItems}
                {...(agent ? { selected: agent.id } : {})}
                recent={recentIds}
                onSelect={selectAgent}
              />
            ),
          },
        }),
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
          {...(agent !== undefined && canEditAgent(session.me, agent)
            ? { skillsHref: `/agents/${encodeURIComponent(agent.id)}?s=skills` }
            : {})}
          initialDraft={sent ? undefined : restore.draft}
          running={false}
          // one message at a time until the conversation exists (it has no queue yet)
          sendDisabled={!agent || sent}
          onBlocked={() => {
            if (sent) setBlocked(true);
          }}
          onSend={send}
          control={composer}
          pickers={{
            ...(environment.picker ? { environment: environment.picker } : {}),
            model: selection.modelPicker,
            ...(selection.effortPicker ? { effort: selection.effortPicker } : {}),
          }}
          // the agent's quick actions: a zap menu after the effort picker, none without any
          {...(!sent && quickActions.length > 0
            ? {
                quickActions: (
                  <QuickActions
                    // keyed by agent: another agent's menu starts closed
                    key={agent?.id ?? ""}
                    items={quickActions.map((q, i) => ({ id: String(i), title: q.title }))}
                    onPick={(id) => {
                      const body = quickActions[Number(id)]?.body;
                      if (body !== undefined) composer.current?.fill(body);
                    }}
                  />
                ),
              }
            : {})}
          placeholder={t("newPlaceholder", { agent: name })}
        />
      </Stack>
    ),
    status: { ...signature, version: session.version ?? "" },
    right: "none",
    onCloseRight: () => {},
  };
}
