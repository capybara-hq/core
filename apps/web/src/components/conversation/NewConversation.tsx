"use client";

import {
  AgentRow,
  type AgentRowItem,
  Button,
  type ConversationPageProps,
  Greeting,
  isTouchPointer,
  LinkButton,
  QuickActionList,
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
  type FirstMessageRequest,
  submitFirstMessage,
} from "../../lib/conversations";
import { type GreetingLines, greetingBucket, pickGreeting } from "../../lib/greeting";
import { canEditAgent } from "../../lib/org-settings";
import { agentsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { modelsQuery, seedNewConversation } from "../../lib/query/conversation";
import { devicesQuery } from "../../lib/query/devices";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { conversationGroupsQuery } from "../../lib/query/shell";
import { HOME_PATH } from "../../lib/routes";
import { useErrorMessage } from "../../lib/use-error-message";
import { ExtensionSlot } from "../extension-ui/ExtensionSlot";
import { FormError } from "../form-error";
import { useSession } from "../shell/session";
import { useDeviceName } from "../use-device-name";
import {
  ComposerBar,
  type ComposerControl,
  type ComposerDraft,
  type ComposerMessage,
  newClientMessageId,
} from "./ComposerBar";
import { useStatusSignature } from "./ConversationView";
import {
  type FirstMessageAttempt,
  firstMessageControls,
  firstMessageIntent,
  isRecoverable,
  recoverableFor,
  retryFirstMessage,
  settleFirstMessage,
  startFirstMessage,
} from "./first-message-attempt";
import { PendingBubbles, usePendingSends } from "./PendingBubbles";
import { PROFILE_KEY, usePermissionChoice } from "./PermissionPicker";
import type { SendResult } from "./useConversation";
import { useDeviceChoice, useSelection } from "./useSelection";

/** How much of an attempt's text its recovery line quotes. */
const SUMMARY_CHARS = 40;

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
 * A new conversation (`/`, the home, spec §5.2, agent profile design §4): the greeting, the agents row,
 * the selected agent's quick actions (the composer's zap menu; on a phone also listed on the page)
 * and the composer (no agent picker: the row picks). The agent
 * is `?agent=` when usable, else the one most recently talked to, else the first in the row's
 * order. The greeting is picked after mount (the server draws its same-height placeholder, so the
 * first paint matches). A quick action fills the composer (one ⌘Z step brings the text back).
 * Nothing is created before the first send: it posts `POST /conversations/first-message` with the
 * message, any model / effort pick and the permission profile chosen in the composer (created
 * with it atomically, never created and then changed), then replaces the URL with the new
 * conversation's. The agents, the most recent agent (the sidebar's first group) and the models
 * come from the query cache.
 *
 * Each first send is an attempt this page owns above the composer's remount
 * (`first-message-attempt.ts`): its id and request bytes are frozen once. No answer leaves its
 * outcome unknown and an unchanged send retries it with the same bytes (the kernel answers the
 * same conversation); a changed send is a new request with a new id, and the earlier one keeps
 * its Retry original. A 409 drops a Full access consent and reads the device's scope again: the
 * person consents again through the dialog, nothing resends on its own.
 *
 * The send is instant (conversation send spec §2.1): the page switches to the conversation layout
 * at once with the pending bubble and the working line; the create's answer seeds the new
 * conversation's cache, and the URL changes without waiting for the sidebar's groups. A failed
 * create goes back to the new conversation with the draft in the composer.
 *
 * `draft` (`?draft=`, a setup guide's 让智能体协助) is the composer's first text: read once at
 * mount (a later address change leaves the text alone), never sent until the person sends it, and
 * never focused into on a touch device (the composer only takes the text).
 */
export function useNewConversationPage(
  orgId: string,
  preferredAgent: string | null,
  draft: string | null = null,
): ConversationPageProps {
  const t = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const session = useSession();
  const signature = useStatusSignature(HOME_PATH);
  const agentsQ = agentsQuery(orgId);
  const agentsRead = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) });
  const agents = agentsRead.data?.agents;
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
    fn: async (v: { orgId: string; serializedBody: string; sentAt: number }) => {
      const r = await submitFirstMessage(v.orgId, v.serializedBody);
      seedNewConversation(qc, v.orgId, r.conversation, r, v.sentAt);
      return r;
    },
    invalidates: () => [],
  });
  const devicesQ = devicesQuery(orgId);
  const devices = useQuery({
    ...devicesQ,
    retryOnMount: retryOnMountOf(devicesQ.queryKey),
  }).data;
  const device = useDeviceChoice(orgId, devices);
  const nameOf = useDeviceName();
  const chosenDevice = devices?.items.find((e) => e.id === device.deviceId);
  const selection = useSelection(providers, agent, undefined, { newConversation: true });
  const pending = usePendingSends(undefined);
  // The profile the first message carries; Full access only through its confirmation, for the
  // device and scope on display (none without a device: no preview is read).
  const permission = usePermissionChoice({
    orgId,
    deviceId: device.deviceId,
    project: device.project,
    deviceLabel: chosenDevice ? nameOf(chosenDevice) : "—",
    context: "new",
  });
  /** This page's first-send attempts, oldest first (they outlive the composer's remounts). */
  const [attempts, setAttempts] = useState<FirstMessageAttempt[]>([]);
  /** One send at a time: a second one while an attempt is on its way is refused. */
  const inFlight = useRef(false);
  /** False once the page is gone: a late answer then neither navigates nor updates it. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /** A failed create's draft, for the composer the new layout mounts again. */
  const [restore, setRestore] = useState<{ n: number; draft?: ComposerDraft }>(() =>
    draft === null
      ? { n: 0 }
      : { n: 0, draft: { text: draft, skill: null, attachments: [], files: [] } },
  );
  /** A second ↵ came before the conversation exists: the composer says why it waits. */
  const [blocked, setBlocked] = useState(false);

  const put = (a: FirstMessageAttempt) =>
    setAttempts((cur) =>
      cur.some((x) => x.clientMessageId === a.clientMessageId)
        ? cur.map((x) => (x.clientMessageId === a.clientMessageId ? a : x))
        : [...cur, a],
    );

  /**
   * Sends one attempt. From the composer (`m`), the page switches to the conversation layout
   * with the pending bubble and navigates on success; Retry original from the recovery line
   * leaves the composer and its newer draft alone and offers the conversation's link instead.
   */
  const run = async (attempt: FirstMessageAttempt, m?: ComposerMessage): Promise<SendResult> => {
    inFlight.current = true;
    setError(undefined);
    put(attempt);
    if (m) pending.add(attempt.message);
    try {
      const { conversation } = await create.mutateAsync({
        orgId: attempt.orgId,
        serializedBody: attempt.serializedBody,
        // this tab's clock at the send: the working line's backstop counts from it
        sentAt: Date.now(),
      });
      // the conversation exists whatever happens to this page: the sidebar shows it
      void qc.invalidateQueries({ queryKey: keys.org(attempt.orgId).conversationGroupsAll() });
      if (!alive.current) return { ok: true };
      put(settleFirstMessage(attempt, { conversationId: conversation.id }));
      if (m) {
        setBlocked(false);
        router.replace(`/chat/${encodeURIComponent(conversation.id)}`);
      }
      return { ok: true };
    } catch (e) {
      if (!alive.current) return { ok: false, error: e };
      const settled = settleFirstMessage(attempt, { error: e });
      put(settled);
      setError(errorMessage(e));
      if (settled.conflict) {
        // the displayed scope may be stale: read it again (the refused request's own device and
        // the one on display) and ask for consent again
        permission.clearFullAccess();
        for (const id of new Set([attempt.deviceId, device.deviceId]))
          if (id != null)
            void qc.invalidateQueries({
              queryKey: keys.org(attempt.orgId).permissionPreviewAll(id),
            });
      }
      if (m) {
        pending.drop(attempt.clientMessageId);
        setBlocked(false);
        setRestore((r) => ({ n: r.n + 1, ...(m.draft !== undefined ? { draft: m.draft } : {}) }));
      }
      return { ok: false, error: e };
    } finally {
      inFlight.current = false;
    }
  };

  const send = async (m: ComposerMessage): Promise<SendResult> => {
    if (!agent) return { ok: false, error: new Error("no agent") };
    if (inFlight.current) return { ok: false, error: new Error("a first message is on its way") };
    const request: FirstMessageRequest = {
      agentId: agent.id,
      message: {
        text: m.text,
        ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
        ...(m.files !== undefined ? { files: m.files } : {}),
        ...(m.skill !== undefined ? { skill: m.skill } : {}),
        ...selection.pending,
      },
      permission: permission.selection,
      ...(device.deviceId !== undefined ? { deviceId: device.deviceId } : {}),
      ...(device.project !== undefined ? { project: device.project } : {}),
    };
    // The same request again is the original's retry (same id, same bytes); anything changed is
    // a new logical request with an id of its own, even when the composer kept its draft's id.
    const original = recoverableFor(attempts, firstMessageIntent(orgId, request));
    if (original) return run(retryFirstMessage(original), m);
    const taken = attempts.some((a) => a.clientMessageId === m.clientMessageId);
    return run(
      startFirstMessage(orgId, request, m, taken ? newClientMessageId() : m.clientMessageId),
      m,
    );
  };

  /** The composer's current choices, to tell an attempt whose choices have since changed. */
  const currentControls = agent
    ? firstMessageControls(orgId, {
        agentId: agent.id,
        message: { text: "", ...selection.pending },
        permission: permission.selection,
        ...(device.deviceId !== undefined ? { deviceId: device.deviceId } : {}),
        ...(device.project !== undefined ? { project: device.project } : {}),
      })
    : undefined;
  /** A recovery line names its attempt: the start of its text, its profile and its device. */
  const summaryOf = (a: FirstMessageAttempt) => {
    const text = a.message.text.trim();
    const excerpt = text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
    const on = a.deviceId === null ? undefined : devices?.items.find((e) => e.id === a.deviceId);
    const profile = t(`permission.profile.${PROFILE_KEY[a.profile]}`);
    return a.deviceId === null
      ? t("firstSend.summaryNoDevice", { text: excerpt, profile })
      : t("firstSend.summary", { text: excerpt, profile, device: on ? nameOf(on) : "—" });
  };

  /** Retry original from the recovery line: the stored bytes, whatever the composer holds now. */
  const retryOriginal = (a: FirstMessageAttempt) => {
    if (inFlight.current) return;
    void run(retryFirstMessage(a));
  };

  const name = agent?.definition.name ?? "—";
  const rowItems: AgentRowItem[] = usable.map((a) => ({
    id: a.id,
    name: a.definition.name,
    description: a.profile.description,
    avatar: avatarValue(a, orgId),
  }));
  const quickActions = agent?.profile.quickActions ?? [];
  const quickItems = quickActions.map((q, i) => ({ id: String(i), title: q.title }));
  // the zap menu and, on a phone, the list on the page: a pick fills the composer
  const pickQuickAction = (id: string) => {
    const body = quickActions[Number(id)]?.body;
    if (body !== undefined) composer.current?.fill(body);
  };
  const selectAgent = (id: string) => {
    setPicked(id);
    // the composer takes the focus, except on a touch device: switching agents never pops the keyboard
    if (!isTouchPointer()) composer.current?.focus();
  };
  // Sent: the conversation layout, the pending bubble then the working line (spec §2.1).
  const sent = pending.shown.length > 0;
  /** An attempt is on its way (also a Retry original, which keeps the new layout). */
  const sending = attempts.some((a) => a.state === "sending");
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
            // a plugin may replace the hero (client extensions spec §6.2); Greeting is the default
            greeting: (
              <ExtensionSlot
                slot="conversation.empty"
                args={{ orgId }}
                host={{
                  builtin: (
                    <Greeting
                      text={greeting}
                      // one usable agent draws no row: nothing to choose, so the line names it
                      sub={
                        usable.length === 1 && agent
                          ? t("greeting.subOne", { agent: name })
                          : t("greeting.sub")
                      }
                    />
                  ),
                  agentId: agent?.id ?? null,
                  greeting: greeting ?? "",
                }}
              />
            ),
            agents: (
              <AgentRow
                agents={rowItems}
                {...(agent ? { selected: agent.id } : {})}
                recent={recentIds}
                onSelect={selectAgent}
              />
            ),
            // a phone lists them on the page (the composer's zap menu gives way there)
            ...(quickItems.length > 0
              ? {
                  quickActions: <QuickActionList items={quickItems} onPick={pickQuickAction} />,
                }
              : {}),
          },
        }),
    // the agents are on the way: the row's placeholder chips keep its box, so nothing moves
    ...(!sent && agentsRead.isPending ? { loading: { agents: true } } : {}),
    composer: (
      <Stack gap={8}>
        {error !== undefined && <FormError message={error} />}
        {!sent && !sending
          ? attempts.map((a) =>
              isRecoverable(a) ? (
                <Stack key={a.clientMessageId} direction="row" gap={8} align="center" wrap>
                  <Text variant="small" tone="muted">
                    {t(a.conflict ? "firstSend.conflict" : "firstSend.unconfirmed")} {summaryOf(a)}{" "}
                    {t(
                      currentControls !== undefined && currentControls !== a.controlsKey
                        ? "firstSend.changed"
                        : "firstSend.newRequest",
                    )}
                  </Text>
                  <Button variant="ghost" onClick={() => retryOriginal(a)}>
                    {t("firstSend.retryOriginal")}
                  </Button>
                </Stack>
              ) : a.state === "resolved" && a.result ? (
                // resolved by Retry original: its own conversation, the newer draft stays here
                <LinkButton
                  key={a.clientMessageId}
                  href={`/chat/${encodeURIComponent(a.result.conversationId)}`}
                >
                  {t("firstSend.open")}
                </LinkButton>
              ) : null,
            )
          : null}
        {agents !== undefined && usable.length === 0 ? <FormError message={t("noAgents")} /> : null}
        {!sent && device.unavailable !== undefined ? (
          <Text variant="small" tone="muted">
            {device.unavailable}
          </Text>
        ) : null}
        {permission.dialog}
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
          // one message at a time until the conversation exists (it has no queue yet); with
          // every local device offline the first send goes without one (Full needs a device)
          sendDisabled={!agent || sent || sending}
          onBlocked={() => {
            if (sent) setBlocked(true);
          }}
          onSend={send}
          control={composer}
          pickers={{
            ...(device.picker ? { device: device.picker } : {}),
            permission: permission.picker,
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
                    items={quickItems}
                    onPick={pickQuickAction}
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
