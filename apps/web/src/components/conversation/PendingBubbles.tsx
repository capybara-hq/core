"use client";

import {
  BubbleAttachments,
  QueuePaused,
  Stack,
  Text,
  UserBubble,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { type ConversationEvent, type QueueItem, resumeQueue } from "../../lib/conversations";
import { retryOnMountOf } from "../../lib/query/client";
import { queueQuery } from "../../lib/query/conversation";
import { useAppMutation } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import type { ComposerMessage } from "./ComposerBar";

/** A message sent from this view that the log does not hold yet (conversation send spec §2.1). */
export type PendingSend = {
  clientMessageId: string;
  text: string;
  skill?: string;
  files: { name: string; kind: "image" | "file" }[];
};

/** The `clientMessageId`s of the log's user messages. */
export function loggedIds(events: readonly ConversationEvent[] | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of events ?? [])
    if (e.type === "user_message" && e.payload.clientMessageId !== undefined)
      out.add(e.payload.clientMessageId);
  return out;
}

/**
 * This view's pending user bubbles, keyed by `clientMessageId`: one shows from the send until the
 * log holds its `user_message` (the POST's answer or the stream, whichever comes first), and is
 * then left out in the same render, so the text never shows twice. Per view, never cached.
 */
export function usePendingSends(events: readonly ConversationEvent[] | undefined): {
  shown: PendingSend[];
  add(m: ComposerMessage): void;
  drop(clientMessageId: string): void;
} {
  const [list, setList] = useState<PendingSend[]>([]);
  const logged = useMemo(() => loggedIds(events), [events]);
  const shown = useMemo(() => list.filter((p) => !logged.has(p.clientMessageId)), [list, logged]);
  const add = useCallback((m: ComposerMessage) => {
    const p: PendingSend = {
      clientMessageId: m.clientMessageId,
      text: m.text,
      ...(m.display?.skill !== undefined ? { skill: m.display.skill } : {}),
      files: m.display?.files ?? [],
    };
    setList((cur) => [...cur.filter((x) => x.clientMessageId !== p.clientMessageId), p]);
  }, []);
  const drop = useCallback(
    (id: string) => setList((cur) => cur.filter((x) => x.clientMessageId !== id)),
    [],
  );
  return { shown, add, drop };
}

/** The pending bubbles after the thread: the user bubble in the queued pattern's pending look. */
export function PendingBubbles({ items }: { items: readonly PendingSend[] }) {
  if (items.length === 0) return null;
  return (
    <Stack gap={12}>
      {items.map((p) => (
        <div key={p.clientMessageId} data-pending={p.clientMessageId}>
          <UserBubble
            text={p.text}
            queued
            {...(p.skill !== undefined ? { skill: p.skill } : {})}
            {...(p.files.length > 0
              ? {
                  attachments: (
                    <BubbleAttachments
                      items={p.files.map((f, i) => ({
                        id: `${p.clientMessageId}:${i}`,
                        kind: f.kind,
                        name: f.name,
                      }))}
                    />
                  ),
                }
              : {})}
          />
        </div>
      ))}
    </Stack>
  );
}

/** The chip of a leftover invocation: the skill's bare name (as the thread's bubble shows it). */
const skillLabel = (name: string) => `/${name.slice(name.indexOf(":") + 1)}`;

const NO_ITEMS: readonly QueueItem[] = [];

/**
 * Messages an older version queued (`GET …/queue`; run input spec 2026-11-07 D3): nothing is
 * queued any more, but the kernel still sends these leftovers one per run after the turn. Until
 * the log holds one (its `clientMessageId`) it shows as a pending bubble, the interjection's
 * 待处理 look, with no actions. A leftover queue a failed or stopped run paused keeps
 * "Continue sending", the only way it ever drains.
 */
export function useLeftovers(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[] | undefined,
): { items: readonly QueueItem[]; paused: boolean; pauseReason?: string } {
  const query = queueQuery(orgId, conversationId);
  const read = useQuery({ ...query, retryOnMount: retryOnMountOf(query.queryKey) }).data;
  const logged = useMemo(() => loggedIds(events), [events]);
  const all = read?.items ?? NO_ITEMS;
  const items = useMemo(() => all.filter((it) => !logged.has(it.clientMessageId)), [all, logged]);
  return {
    items,
    paused: read?.paused ?? false,
    ...(read?.pauseReason !== undefined ? { pauseReason: read.pauseReason } : {}),
  };
}

/** The leftover queued messages after the thread, as pending bubbles. */
export function LeftoverBubbles({
  orgId,
  conversationId,
  events,
}: {
  orgId: string;
  conversationId: string;
  events: readonly ConversationEvent[] | undefined;
}) {
  const t = useTranslations("chat");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const left = useLeftovers(orgId, conversationId, events);
  const resume = useAppMutation({
    fn: () => resumeQueue(orgId, conversationId),
    invalidates: () => [queueQuery(orgId, conversationId).queryKey],
  });
  if (left.items.length === 0) return null;
  return (
    <Stack gap={12}>
      {left.items.map((it) => (
        <div key={it.id} data-leftover={it.id}>
          <UserBubble
            text={it.text}
            queued
            {...(it.skill !== undefined ? { skill: skillLabel(it.skill.name) } : {})}
            details={
              <Text variant="small" tone="faint">
                {t("interjectionPending")}
              </Text>
            }
            {...(it.files.length > 0
              ? {
                  attachments: (
                    <BubbleAttachments
                      items={it.files.map((f) => ({
                        id: f.attachmentId,
                        kind: f.mediaType.startsWith("image/") ? "image" : "file",
                        name: f.name,
                      }))}
                    />
                  ),
                }
              : {})}
          />
        </div>
      ))}
      {left.paused ? (
        <QueuePaused
          count={left.items.length}
          busy={resume.isPending}
          {...(left.pauseReason === "author_cannot_send" ||
          left.pauseReason === "skill_not_invocable"
            ? { text: t(`queuePaused.${left.pauseReason}`) }
            : {})}
          onContinue={() =>
            resume.mutateAsync(undefined).catch((e) => toast.error(errorMessage(e)))
          }
        />
      ) : null}
    </Stack>
  );
}
