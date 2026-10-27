"use client";

import {
  type ConversationPageProps,
  elapsed,
  type PickerProps,
  RenameDialog,
  Stack,
  type TitleBarMenuItem,
  untitledLabel,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type Agent, listAgents } from "../../lib/agents";
import {
  type ModelRef,
  notifyConversationsChanged,
  renameConversation,
} from "../../lib/conversations";
import { usageTotal, useSubagents, useUsageWithSubagents } from "../../lib/subagents";
import {
  buildTimeline,
  type DividerData,
  latestModel,
  latestUsage,
  runStats,
  toolKeysOf,
  usedTokens,
} from "../../lib/timeline";
import { useToolInfo } from "../../lib/tool-info";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { useSession } from "../shell/session";
import { ComposerBar, type ComposerMessage, newClientMessageId } from "./ComposerBar";
import { useRightAreaSlot } from "./RightArea";
import { Thread, type ThreadProps } from "./Thread";
import { type SendResult, useConversation } from "./useConversation";
import { QueueList, useQueue } from "./useQueue";
import { useModels, useSelection } from "./useSelection";

/** The org's agents (for the agent's name, model and saved effort); undefined while loading. */
export function useAgentList(orgId: string): Agent[] | undefined {
  const [agents, setAgents] = useState<Agent[]>();
  useEffect(() => {
    let live = true;
    listAgents(orgId).then(
      (r) => {
        if (live) setAgents(r.agents);
      },
      () => {
        if (live) setAgents([]);
      },
    );
    return () => {
      live = false;
    };
  }, [orgId]);
  return agents;
}

/** "user@org" for the status bar's context path. */
export function useWho(): string {
  const { me } = useSession();
  const org = me.memberships.find((m) => m.orgId === me.currentOrgId);
  return `${me.account.displayName}${org ? `@${org.name}` : ""}`;
}

/** Re-renders every second while `active`. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** What Task 20 adds around the thread: the right area (title-bar panels, properties, panel). */
export type RightAreaSlot = {
  titleBarPanels: ConversationPageProps["titleBar"]["panels"];
  properties: { pressed: boolean; onToggle(): void };
  right: "none" | "properties" | "panel";
  propertiesNode?: ReactNode;
  panelNode?: ReactNode;
  onCloseRight(): void;
  thread: Pick<
    ThreadProps,
    | "onOpenFile"
    | "onMoreFiles"
    | "onOpenOutput"
    | "selectedFile"
    | "removedFiles"
    | "filePaths"
    | "renderCard"
    | "openSubagent"
    | "onOpenSubagent"
  >;
};

/**
 * The conversation page (`/chat/<id>`, spec §5) as `ConversationPage` props: the title bar (title,
 * rename, properties, panels), the thread built by `lib/timeline.ts`, the queue, the composer
 * (pickers, ↵ / ⌘↵) and the status bar; `dialogs` go next to the page. Use it in a component keyed
 * by the conversation id: everything here (drafts, queue, picks, the right area) belongs to one
 * conversation and never shows under another.
 */
export function useConversationPage(
  orgId: string,
  conversationId: string,
): { page: ConversationPageProps; dialogs: ReactNode } {
  const t = useTranslations("chat");
  const ts = useTranslations("subagents");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const session = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const who = useWho();
  const conv = useConversation(orgId, conversationId);
  const agents = useAgentList(orgId);
  const agent = agents?.find((a) => a.id === conv.conversation?.agentId);
  const providers = useModels(orgId);
  const selection = useSelection(providers, agent, conv.conversation?.selection);
  const keys = useMemo(() => toolKeysOf(conv.events), [conv.events]);
  const info = useToolInfo(orgId, conversationId, keys);
  const subagents = useSubagents(
    orgId,
    conversationId,
    conv.events,
    conv.state.progress,
    conv.changes.reconnect,
    conv.seedProgress,
  );
  const usageAll = useUsageWithSubagents(orgId, conversationId, conv.events);
  const views = useMemo(
    () => (subagents.views ? new Map(subagents.views.map((v) => [v.id, v])) : undefined),
    [subagents.views],
  );
  const entries = useMemo(
    () =>
      buildTimeline(conv.events, conv.state.drafts, info, locale, {
        progress: conv.state.progress,
        ...(views ? { views } : {}),
      }),
    [conv.events, conv.state.drafts, info, locale, conv.state.progress, views],
  );
  const queue = useQueue(orgId, conversationId, conv.changes.queue, conv.merge);
  const [renaming, setRenaming] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const active = conv.running || conv.waiting;
  const stats = runStats(conv.events);
  const now = useClock(stats.startedAt !== null && stats.endedAt === null);

  const send = async (m: ComposerMessage): Promise<SendResult> => {
    const r = await conv.send({ ...m, ...selection.pending });
    if (r.ok) selection.sent();
    return r;
  };

  const retry = (d: Extract<DividerData, { divider: "failed" }>) => {
    if (d.retry === null) return;
    void conv
      .send({
        text: d.retry.text,
        clientMessageId: newClientMessageId(),
        files: d.retry.files.map((f) => f.attachmentId),
        retryOf: d.retry.seq,
        ...selection.pending,
      })
      .then((r) => {
        if (r.ok) selection.sent();
      });
  };

  const rename = async (title: string) => {
    setRenameBusy(true);
    try {
      const { conversation } = await renameConversation(orgId, conversationId, title);
      conv.setConversation(conversation);
      notifyConversationsChanged();
      setRenaming(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRenameBusy(false);
    }
  };

  const menu: TitleBarMenuItem[] = [
    { id: "rename", label: t("rename"), icon: "square-pen", onSelect: () => setRenaming(true) },
    {
      id: "copy-link",
      label: t("copyLink"),
      icon: "link",
      onSelect: () =>
        navigator.clipboard?.writeText(window.location.href).then(
          () => toast.success(t("copied")),
          () => {},
        ),
    },
  ];

  // Context: the latest step call's usage against its model's window.
  const usage = latestUsage(conv.events);
  const usageModel: ModelRef | null = usage
    ? { provider: usage.provider, model: usage.model }
    : latestModel(conv.events);
  const window_ = usageModel ? selection.contextWindowOf(usageModel) : undefined;
  const contextPct =
    usage && window_ && window_ > 0 ? Math.round((usedTokens(usage) / window_) * 100) : null;
  const statusText = conv.running
    ? t("status.running")
    : conv.waiting
      ? t("status.waiting")
      : stats.last === "aborted"
        ? t("status.stopped")
        : stats.last === "failed"
          ? t("status.failed")
          : t("status.idle");
  const elapsedMs = stats.startedAt === null ? null : (stats.endedAt ?? now) - stats.startedAt;

  const slot: RightAreaSlot | undefined = useRightAreaSlot({
    orgId,
    conversationId,
    events: conv.events,
    entries,
    uiVersions: conv.uiVersions,
    filesVersion: conv.changes.files,
    model: usageModel,
    contextPct,
    subagents: subagents.views,
    total:
      usageAll === undefined
        ? undefined
        : `${ts("contextTotal")} ${usageTotal(usageAll).toLocaleString(locale)}`,
    contextWindowOf: selection.contextWindowOf,
    reasoningOf: selection.reasoningOf,
  });

  const agentPicker: PickerProps = {
    label: t("pickAgent"),
    value: agent?.definition.name ?? "—",
    locked: { hint: t("agentLocked") },
    groups: [],
    onPick: () => {},
  };

  const createdAt = conv.conversation ? new Date(conv.conversation.createdAt) : new Date();
  const page: ConversationPageProps = {
    titleBar: {
      title: conv.conversation?.title ?? null,
      untitled: untitledLabel(createdAt, locale),
      menu,
      properties: slot?.properties ?? { pressed: false, onToggle: () => {} },
      panels: slot?.titleBarPanels ?? [],
    },
    thread: (
      <>
        <Thread
          orgId={orgId}
          conversationId={conversationId}
          entries={entries}
          info={info}
          reasoningOf={selection.reasoningOf}
          {...(active ? {} : { onRetry: retry })}
          {...(slot?.thread ?? {})}
        />
        <QueueList queue={queue} />
      </>
    ),
    composer: (
      <Stack gap={8}>
        {conv.error !== undefined && <FormError message={conv.error} />}
        <ComposerBar
          orgId={orgId}
          running={active}
          stop={{ onStop: conv.stop, stopping: conv.stopping }}
          onSend={send}
          onQueue={queue.add}
          pickers={{
            agent: agentPicker,
            model: selection.modelPicker,
            ...(selection.effortPicker ? { effort: selection.effortPicker } : {}),
          }}
          placeholder={t("placeholder")}
        />
      </Stack>
    ),
    status: {
      context: `${who}:/chat/${conversationId.slice(0, 8)}`,
      ...(stats.turns > 0
        ? {
            stats: t("stats", {
              n: stats.turns,
              elapsed: elapsedMs === null ? "—" : elapsed(elapsedMs, locale),
            }),
          }
        : {}),
      right: [statusText, ...(contextPct !== null ? [t("contextPct", { n: contextPct })] : [])],
      version: session.version ?? "",
    },
    right: slot?.right ?? "none",
    ...(slot?.propertiesNode !== undefined ? { properties: slot.propertiesNode } : {}),
    ...(slot?.panelNode !== undefined ? { panel: slot.panelNode } : {}),
    onCloseRight: slot?.onCloseRight ?? (() => {}),
  };
  const dialogs = renaming ? (
    <RenameDialog
      value={conv.conversation?.title ?? ""}
      busy={renameBusy}
      onSave={(v) => void rename(v)}
      onCancel={() => setRenaming(false)}
    />
  ) : null;
  return { page, dialogs };
}
