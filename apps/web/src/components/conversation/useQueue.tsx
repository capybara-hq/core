"use client";

import { QueuedMessage, QueuePaused, Stack, useToast } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import {
  type ConversationEvent,
  deleteQueued,
  editQueued,
  enqueueMessage,
  type MessageInput,
  type QueueItem,
  type QueuePauseReason,
  resumeQueue,
  sendQueuedNow,
} from "../../lib/conversations";
import { retryOnMountOf } from "../../lib/query/client";
import { queueQuery } from "../../lib/query/conversation";
import { useAppMutation } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import type { ComposerMessage } from "./ComposerBar";
import type { SendResult } from "./useConversation";

export type QueueView = {
  items: QueueItem[];
  paused: boolean;
  /** Why it paused, when the kernel recorded it (phase D). */
  pauseReason?: QueuePauseReason;
  /** ⌘↵ while running: queue a message (an idle conversation sends it at once). */
  add(m: ComposerMessage & Pick<MessageInput, "model" | "effort">): Promise<SendResult>;
};

/**
 * The conversation's queued messages (kernel queue routes, spec §5.7) through the query cache:
 * `changed: queue` invalidates it, and so does each of this page's own changes. A failed read
 * shows an empty queue until the next one. The queue lives in PG, so a reload, another tab or
 * another replica see the same list.
 */
export function useQueue(
  orgId: string,
  conversationId: string,
  merge: (events: ConversationEvent[]) => void,
): QueueView & {
  reload(): void;
  edit(id: string, text: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  sendNow(id: string): Promise<void>;
  resume(): Promise<void>;
} {
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const query = queueQuery(orgId, conversationId);
  const state = useQuery({ ...query, retryOnMount: retryOnMountOf(query.queryKey) }).data ?? EMPTY;
  const reload = useCallback(
    () => void qc.invalidateQueries({ queryKey: query.queryKey }),
    [qc, query.queryKey],
  );
  const invalidates = () => [query.queryKey];
  const enqueue = useAppMutation({
    fn: async (m: ComposerMessage & Pick<MessageInput, "model" | "effort">) => {
      const r = await enqueueMessage(orgId, conversationId, m);
      if (r.event) merge([r.event]);
      return r;
    },
    invalidates,
  });
  const editMutation = useAppMutation({
    fn: (v: { id: string; text: string }) => editQueued(orgId, conversationId, v.id, v.text),
    invalidates,
  });
  const removeMutation = useAppMutation({
    fn: (id: string) => deleteQueued(orgId, conversationId, id),
    invalidates,
  });
  const sendNowMutation = useAppMutation({
    fn: async (id: string) => {
      const { event } = await sendQueuedNow(orgId, conversationId, id);
      merge([event]);
    },
    invalidates,
  });
  const resumeMutation = useAppMutation({
    fn: () => resumeQueue(orgId, conversationId),
    invalidates,
  });

  // A failure says why; the queue is read again either way (it may have moved meanwhile).
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      toast.error(errorMessage(e));
      reload();
    }
  };

  return {
    ...state,
    reload,
    add: async (m) => {
      try {
        await enqueue.mutateAsync(m);
        return { ok: true };
      } catch (e) {
        toast.error(errorMessage(e));
        return { ok: false, error: e };
      }
    },
    edit: async (id, text) => {
      try {
        await editMutation.mutateAsync({ id, text });
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    remove: (id) => act(() => removeMutation.mutateAsync(id)),
    sendNow: (id) => act(() => sendNowMutation.mutateAsync(id)),
    resume: () => act(() => resumeMutation.mutateAsync(undefined)),
  };
}

const EMPTY: { items: QueueItem[]; paused: boolean; pauseReason?: QueuePauseReason } = {
  items: [],
  paused: false,
};

/** The chip of a queued invocation: the skill's bare name (as the thread's bubble shows it). */
const skillLabel = (name: string) => name.slice(name.indexOf(":") + 1);

/** The queued bubbles under the thread, and "Continue sending" when paused. */
export function QueueList({ queue }: { queue: ReturnType<typeof useQueue> }) {
  const t = useTranslations("chat");
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (queue.items.length === 0) return null;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of queued bubbles (no styles in web)
    <div role="group" aria-label={t("queueLabel")} data-entry="queue">
      <Stack gap={12}>
        {queue.items.map((it) => (
          <div key={it.id} data-queue-item={it.id}>
            <QueuedMessage
              text={it.text}
              {...(it.skill !== undefined ? { skill: `/${skillLabel(it.skill.name)}` } : {})}
              editing={editing === it.id}
              paused={queue.paused}
              busy={busy}
              onCopy={() =>
                navigator.clipboard?.writeText(it.text).then(
                  () => toast.success(t("copied")),
                  () => {},
                )
              }
              onEdit={() => setEditing(it.id)}
              onCancelEdit={() => setEditing(null)}
              onSave={(text) =>
                void run(async () => {
                  if (await queue.edit(it.id, text)) setEditing(null);
                })
              }
              onDelete={() => void run(() => queue.remove(it.id))}
              onSendNow={() => void run(() => queue.sendNow(it.id))}
            />
          </div>
        ))}
        {queue.paused ? (
          <QueuePaused
            count={queue.items.length}
            busy={busy}
            {...(queue.pauseReason === "author_cannot_send" ||
            queue.pauseReason === "skill_not_invocable"
              ? { text: t(`queuePaused.${queue.pauseReason}`) }
              : {})}
            onContinue={() => void run(() => queue.resume())}
          />
        ) : null}
      </Stack>
    </div>
  );
}
