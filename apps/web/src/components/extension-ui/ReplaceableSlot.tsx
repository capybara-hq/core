"use client";

import { ReplaceableFrame } from "@capybara-hq/design";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { UiSlotId } from "../../lib/ui";
import { uiKey } from "../../lib/ui";
import { useClientHostControls } from "../client-ext/registry";
import {
  ClientBoundary,
  ComponentHost,
  useClientComponent,
  useSlotHasClientCode,
} from "./ClientComponentBlock";
import { useSlotContributions } from "./ExtensionSlot";

/** `CLIENT_LIMITS.pendingMs`: how long a loading winner may keep the built-in hidden. */
export const REPLACEABLE_PENDING_MS = 1500;

/** The composer's text field: it must stay inside the composer frame slot, exactly once. */
const COMPOSER_TEXTAREA = '[data-cap-part~="composer"] textarea';

/** The single slots a contribution may take instead of the built-in (spec §6.2). */
export type ReplaceableSlotId =
  | "shell.brand"
  | "conversation.empty"
  | "conversation.composer.frame";

/**
 * Throws once the slot (`scope`, the slot's frame) no longer holds exactly one composer textarea:
 * checked after every commit of the slot and on every DOM change inside it, so a winner that drops
 * its `children` on its own re-render is caught too, and so is one rendering them twice (two
 * composers would share one textarea ref). The boundary around the winner then falls back to the
 * built-in (spec §5.3: the composer must always be usable).
 */
function ComposerGuard({ scope }: { scope: HTMLDivElement | null }) {
  const [missing, setMissing] = useState(false);
  // `scope` arrives after the frame's first commit (a parent's ref is set after its children's
  // layout effects), so both checks run again once it is there
  const lost = useCallback(
    () => scope !== null && scope.querySelectorAll(COMPOSER_TEXTAREA).length !== 1,
    [scope],
  );
  // every commit of the slot: the winner's DOM is in place before layout effects run
  useLayoutEffect(() => {
    if (!missing && lost()) setMissing(true);
  });
  // the winner's own re-renders: watch the slot's subtree
  useLayoutEffect(() => {
    if (scope === null || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (lost()) setMissing(true);
    });
    observer.observe(scope, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [scope, lost]);
  if (missing) {
    throw new Error("the composer frame did not render the composer (its children) exactly once");
  }
  return null;
}

/**
 * A replaceable single slot (client extensions spec §6.3, §6.4): the winner the kernel lists (at
 * most one) or the built-in. The built-in is what renders when there is no winner, in safe mode,
 * under the kill switch, and when the winner fails to load, is off or lacks the component. Before
 * the client host has loaded (the server render and the first client render, so hydration never
 * mismatches) the built-in renders too, hidden when the layout prefetched a winner the document's
 * set delivers. While the winner's module loads (or, with client code for the slot, the read
 * naming the winner) the built-in is hidden in a `ReplaceableFrame` (its layout kept) for at most
 * 1 500 ms, then shown until the module arrives; the frame's CSS reveals it after 1 500 ms even
 * without scripts. A winner that throws, or a composer frame that does not render the composer
 * (its `children`) exactly once inside the slot, falls back to the built-in for this mount,
 * reported once (and counted against the plugin's crash budget). A composer frame that portals
 * `children` out of its slot counts as dropping them: they must render inside the frame. The
 * winner gets `builtin`, `extra` and the base props.
 */
export function ReplaceableSlot({
  slot,
  args,
  builtin,
  extra,
}: {
  slot: ReplaceableSlotId;
  args: { orgId: string };
  builtin: ReactNode;
  extra: Record<string, unknown>;
}): ReactNode {
  const code = useSlotHasClientCode(slot);
  const { items, pending } = useSlotContributions(args.orgId, slot as UiSlotId, code);
  const winner = items.find((c) => c.kind === "component");
  const found = useClientComponent(winner);
  const controls = useClientHostControls();
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  // The winner's module, or the read naming the winner, is on its way.
  const loading = found.status === "loading" || (code && pending);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setWaited(true), REPLACEABLE_PENDING_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  const plugin = winner?.plugin;
  const id = winner?.id;
  const onError = useCallback(
    (error: unknown) => {
      if (plugin !== undefined && id !== undefined)
        controls.reportError(plugin, id, "render", error);
    },
    [controls, plugin, id],
  );
  if (winner === undefined || found.status !== "ready") {
    return <ReplaceableFrame pending={loading && !waited}>{builtin}</ReplaceableFrame>;
  }
  return (
    <ReplaceableFrame pending={false} ref={setFrame}>
      <ClientBoundary key={uiKey(winner.plugin, winner.id)} fallback={builtin} onError={onError}>
        <ComponentHost
          c={winner}
          args={{ orgId: args.orgId }}
          render={found.render}
          hostProps={{ ...extra, builtin }}
        />
        {slot === "conversation.composer.frame" ? <ComposerGuard scope={frame} /> : null}
      </ClientBoundary>
    </ReplaceableFrame>
  );
}
