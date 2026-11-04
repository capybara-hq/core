"use client";

import { BubbleAttachments, Stack, UserBubble } from "@capybara-hq/design";
import { useCallback, useMemo, useState } from "react";
import type { ConversationEvent } from "../../lib/conversations";
import type { ComposerMessage } from "./ComposerBar";

/** A message sent from this view that the log does not hold yet (conversation send spec §2.1). */
export type PendingSend = {
  clientMessageId: string;
  text: string;
  skill?: string;
  files: { name: string; kind: "image" | "file" }[];
};

/** The `clientMessageId`s of the log's user messages. */
function loggedIds(events: readonly ConversationEvent[] | undefined): ReadonlySet<string> {
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
