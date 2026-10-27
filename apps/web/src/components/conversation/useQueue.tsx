"use client";

import { QueuedMessage, QueuePaused, Stack, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import {
  type ConversationEvent,
  deleteQueued,
  editQueued,
  enqueueMessage,
  listQueue,
  type MessageInput,
  type QueueItem,
  resumeQueue,
  sendQueuedNow,
} from "../../lib/conversations";
import { useErrorMessage } from "../../lib/use-error-message";
import type { ComposerMessage } from "./ComposerBar";
import type { SendResult } from "./useConversation";

export type QueueView = {
  items: QueueItem[];
  paused: boolean;
  /** ⌘↵ while running: queue a message (an idle conversation sends it at once). */
  add(m: ComposerMessage & Pick<MessageInput, "model" | "effort">): Promise<SendResult>;
};

/**
 * The conversation's queued messages (kernel queue routes, spec §5.7): read at mount and again on
 * `changed: queue` (`version`), after each of this page's own changes. The queue lives in PG, so a
 * reload, another tab or another replica see the same list.
 */
export function useQueue(
  orgId: string,
  conversationId: string,
  version: number,
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
  const [state, setState] = useState<{ items: QueueItem[]; paused: boolean }>({
    items: [],
    paused: false,
  });
  const reload = useCallback(() => {
    listQueue(orgId, conversationId).then(
      (r) => setState({ items: r.items, paused: r.paused }),
      () => {
        // The thread keeps working; the queue shows what was last read.
      },
    );
  }, [orgId, conversationId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` triggers a refetch
  useEffect(() => {
    reload();
  }, [reload, version]);

  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      reload();
    }
  };

  return {
    ...state,
    reload,
    add: async (m) => {
      try {
        const r = await enqueueMessage(orgId, conversationId, m);
        if (r.event) merge([r.event]);
        reload();
        return { ok: true };
      } catch (e) {
        toast.error(errorMessage(e));
        return { ok: false, error: e };
      }
    },
    edit: async (id, text) => {
      try {
        await editQueued(orgId, conversationId, id, text);
        reload();
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    remove: (id) => act(() => deleteQueued(orgId, conversationId, id)),
    sendNow: (id) =>
      act(async () => {
        const { event } = await sendQueuedNow(orgId, conversationId, id);
        merge([event]);
      }),
    resume: () => act(() => resumeQueue(orgId, conversationId)),
  };
}

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
            onContinue={() => void run(() => queue.resume())}
          />
        ) : null}
      </Stack>
    </div>
  );
}
