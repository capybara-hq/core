"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { type InboxItem, isShowable } from "./inbox";
import { inboxQuery } from "./query/inbox";
import { useNotifyCapability } from "./shell";

/** How often the inbox is read while the shell can notify (also while the window is hidden). */
const INBOX_POLL_MS = 30_000;
const SEEN_KEY = "capybara.shell.notified";

/**
 * The item ids already handled in this browser session, in `sessionStorage`: a reload of the same
 * window does not notify an item again, while a new session (the app restarted, a new window) does
 * remind of what still waits. The set is per window and dies with it, so it never grows without
 * bound. `null` when nothing was recorded yet (the first read of the session) or storage is
 * blocked (then the module's own set below carries the session until the page reloads).
 */
function readSeen(): Set<string> | null {
  try {
    const raw = window.sessionStorage.getItem(SEEN_KEY);
    if (raw === null) return null;
    const ids: unknown = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === "string") : []);
  } catch {
    return null;
  }
}

function writeSeen(seen: Set<string>): void {
  try {
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // blocked: the in-memory set still stops a second notification until a reload
  }
}

/**
 * Native notifications for new inbox items in the desktop shell (`notify@1`, desktop client spec
 * §8): an item that appears after the first read of the session calls `notify({ title, body, path })`
 * once per item id, only while the window is hidden (a visible window shows it itself). The first
 * read only records what already waits. Without `notify@1` nothing is read or called. Mounted once
 * in the workspace frame; `notify` runs from an effect, which is fine because it asks for no
 * confirmation.
 */
export function useShellNotifications(orgId: string): void {
  const cap = useNotifyCapability();
  const t = useTranslations("shellNotify");
  const q = useQuery({
    ...inboxQuery(orgId),
    enabled: cap !== undefined,
    refetchInterval: INBOX_POLL_MS,
    refetchIntervalInBackground: true,
  });
  const items = q.data?.items;
  const memory = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (cap === undefined || items === undefined) return;
    const seen = memory.current ?? readSeen();
    const showable = items.filter(isShowable);
    if (seen === null) {
      // the first read of the session: what already waits is not new
      const first = new Set(showable.map((i) => i.id));
      memory.current = first;
      writeSeen(first);
      return;
    }
    const fresh = showable.filter((i) => !seen.has(i.id));
    memory.current = seen;
    if (fresh.length === 0) return;
    const hidden = document.visibilityState === "hidden";
    for (const i of fresh) {
      seen.add(i.id);
      if (hidden) {
        const sent = cap.notify({ title: t("title"), body: t(bodyKey(i)), path: "/inbox" });
        // a refused notification is no error worth showing
        void Promise.resolve(sent).catch(() => {});
      }
    }
    writeSeen(seen);
  }, [cap, items, t]);
}

const BODY_TYPES = [
  "tool_approval",
  "skill_change",
  "catalog_request",
  "catalog_request_decided",
  "schedule_attention",
] as const;

function bodyKey(i: InboxItem): (typeof BODY_TYPES)[number] | "other" {
  return BODY_TYPES.find((k) => k === i.type) ?? "other";
}
