"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Conversation } from "../../lib/conversations";
import { retryOnMountOf } from "../../lib/query/client";
import { conversationQuery } from "../../lib/query/conversation";
import { keys } from "../../lib/query/keys";
import { raisePermissionWatermark, refreshPermissionViews } from "../../lib/query/permission-state";
import { onForeground, openConversationStream, type StreamCloser } from "../../lib/stream";

/** Consecutive reopen attempts after the browser gave up the root stream (reset by any open). */
const MAX_REOPEN = 3;

/**
 * An owner's child conversation follows its root's permission profile live (permission profiles
 * Task 10, Important 1): the root's `permission_profile_changed` is written to the root only, so an
 * idle child (no pending card, no event of its own) learns of a change through the root's
 * existing stream, opened here notification-only.
 *
 * - Enabled only with `rootId` (the caller passes it only for its owner, from the authoritative
 *   permissions read) when it differs from the viewed conversation: a root uses its own stream, a
 *   viewer opens nothing and reads nothing.
 * - The root row (an owner-enabled `conversationQuery`) supplies the starting cursor; no root log
 *   is read or cached. Every delivered root seq advances the cursor; a repeated or older seq is
 *   ignored. Root events never enter the child's event window.
 * - Every open (the first and each automatic reconnect) refreshes the permission views naming the
 *   root, cancelling a first read that predates it: a change between the first read and the
 *   subscription, or while disconnected, is caught even when no event follows.
 * - A root profile event raises the root's watermark before its views are read again.
 * - The browser giving up: the root row is read again (refreshing the session), then the stream
 *   reopens from the retained cursor, a bounded number of times. A server error frame stops it.
 * - Back in the foreground (`visibilitychange` to visible, `pageshow`, `online`): a closed stream
 *   (dropped by a suspended page, or given up) reopens from the cursor; an open one is left alone.
 * - Another org, account, viewed conversation or root, or unmount: the stream closes and late
 *   callbacks of the old one change nothing.
 */
export function useRootPermissionSubscription(o: {
  orgId: string;
  accountId: string;
  viewedId: string;
  rootId: string | undefined;
}): void {
  const { orgId, accountId, viewedId, rootId } = o;
  const qc = useQueryClient();
  const enabled = rootId !== undefined && rootId !== viewedId;
  const rootQ = conversationQuery(orgId, rootId ?? "");
  const root = useQuery({
    ...rootQ,
    enabled,
    retryOnMount: retryOnMountOf(rootQ.queryKey),
  });
  const ready = enabled && root.data !== undefined;
  useEffect(() => {
    if (!ready || rootId === undefined) return;
    const rowKey = keys.org(orgId).conversation(rootId).row();
    let cursor = qc.getQueryData<Conversation>(rowKey)?.lastSeq ?? 0;
    let disposed = false;
    let close: StreamCloser | undefined;
    let failures = 0;
    // a reopen after a give-up is under way / the server stopped the stream: no foreground reopen
    let reopening = false;
    let stopped = false;
    const scope = { accountId, orgId, rootId };
    // the viewed child's own key too, even before its cached view names the root
    const refresh = () =>
      refreshPermissionViews(qc, orgId, rootId, [
        keys.org(orgId).conversation(viewedId).permissions(),
      ]);
    const open = () => {
      close = openConversationStream(
        orgId,
        rootId,
        cursor,
        {
          onOpen: () => {
            if (disposed) return;
            failures = 0;
            refresh();
          },
          onEvent: (e) => {
            if (disposed || e.seq <= cursor) return;
            cursor = e.seq;
            if (e.type === "permission_profile_changed") {
              raisePermissionWatermark(qc, scope, e.payload.revision);
              refresh();
            }
          },
          onDelta: () => {},
          onError: ({ code }) => {
            if (disposed) return;
            // a server error frame (access revoked, signed out): stop; the views stay as read
            if (code !== undefined) {
              stopped = true;
              return;
            }
            if (++failures > MAX_REOPEN) return;
            reopening = true;
            qc.fetchQuery({ ...conversationQuery(orgId, rootId), staleTime: 0 }).then(
              () => {
                reopening = false;
                if (!disposed) open();
              },
              () => {
                reopening = false;
              },
            );
          },
        },
        { eventsOnly: true },
      );
    };
    open();
    // Back in the foreground (mobile layout spec §7.6): a closed stream reopens from the cursor.
    const offForeground = onForeground(() => {
      if (disposed || stopped || reopening || (close !== undefined && !close.isClosed())) return;
      close?.();
      failures = 0;
      open();
    });
    return () => {
      disposed = true;
      offForeground();
      close?.();
    };
  }, [ready, orgId, accountId, viewedId, rootId, qc]);
}
