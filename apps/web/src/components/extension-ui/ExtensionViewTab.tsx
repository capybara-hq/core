"use client";

import { Button, Skeleton, Stack, useToast } from "@capybara-hq/design";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { ApiClientError } from "../../lib/api";
import { useAppMutation } from "../../lib/query/define";
import { type UiViewTarget, uiViewQuery } from "../../lib/query/ui";
import {
  postUiAction,
  type UiActionRequest,
  type UiLocale,
  type UiView,
  uiKey,
} from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { UiViewRenderer } from "../ui-view/UiViewRenderer";

/** 一个插件视图的取数状态。重取期间保留上一次的视图（不闪回加载中）；重取失败显示错误。 */
export type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; view: UiView }
  | { kind: "error"; code: string };

export interface ViewTarget {
  plugin: string;
  id: string;
  /** The state key (default `plugin/id`): distinct targets of one contribution need their own. */
  key?: string;
  /** An open target's item (a panel scrolled to it). */
  item?: string;
  /** The tool call an inline card hangs off. */
  card?: { callId: string; key?: string };
  /** Not shown now (an inline card out of view): it keeps its view and reads none. */
  paused?: boolean;
}

/** The state key of a target. */
export const targetKey = (t: ViewTarget) => t.key ?? uiKey(t.plugin, t.id);

/** The read of a target. */
const readOf = (t: ViewTarget): UiViewTarget => ({
  plugin: t.plugin,
  id: t.id,
  ...(t.item !== undefined && { item: t.item }),
  ...(t.card !== undefined && { card: t.card }),
});

/**
 * Loads a set of extension views independently, through the query cache (`uiViewQuery`): one
 * failing (slow, throwing, an invalid view) only affects its own state (review focus 1). Refreshes
 * come from `refreshUiViews` (the UI stream's `event: ui`, coalesced to at most one read in
 * flight per view); `retry(key)` goes back to loading and reads once more; `setView` replaces a
 * view with the one an action returned. `initial` holds views the server already read (by state
 * key): they go into the cache when it has none, so they are not read on mount.
 */
export function useExtensionViews(
  orgId: string,
  targets: readonly ViewTarget[],
  opts: {
    conversationId?: string;
    locale: UiLocale;
    initial?: Readonly<Record<string, ViewState>>;
  },
): {
  states: Readonly<Record<string, ViewState>>;
  retry(key: string): void;
  setView(key: string, view: UiView): void;
} {
  const { conversationId, locale } = opts;
  const qc = useQueryClient();
  const queries = targets.map((t) =>
    uiViewQuery(orgId, readOf(t), {
      ...(conversationId !== undefined && { conversationId }),
      locale,
    }),
  );
  // The server's reads seed the cache once (a failed one stays an error until a retry).
  useState(() => {
    targets.forEach((t, i) => {
      const seed = opts.initial?.[targetKey(t)];
      const q = queries[i];
      if (seed?.kind === "ready" && q && qc.getQueryData(q.queryKey) === undefined)
        qc.setQueryData(q.queryKey, seed.view);
    });
  });
  const failedOnServer = (t: ViewTarget) => opts.initial?.[targetKey(t)]?.kind === "error";
  const [retried, setRetried] = useState<ReadonlySet<string>>(new Set());
  const results = useQueries({
    queries: queries.map((q, i) => {
      const t = targets[i] as ViewTarget;
      // A view the server failed is not read on mount: its retry reads it.
      const hold = (failedOnServer(t) && !retried.has(targetKey(t))) || t.paused === true;
      return { ...q, enabled: !hold, retry: false };
    }),
  });
  const states: Record<string, ViewState> = {};
  targets.forEach((t, i) => {
    const r = results[i];
    const key = targetKey(t);
    const seed = opts.initial?.[key];
    if (r?.data !== undefined) states[key] = { kind: "ready", view: r.data };
    else if (r?.error)
      states[key] = {
        kind: "error",
        code: r.error instanceof ApiClientError ? r.error.code : "unknown",
      };
    else if (seed?.kind === "error" && !retried.has(key)) states[key] = seed;
    else states[key] = { kind: "loading" };
  });
  const keyed = new Map(targets.map((t, i) => [targetKey(t), queries[i]?.queryKey]));
  const retry = (key: string) => {
    setRetried((s) => new Set(s).add(key));
    const queryKey = keyed.get(key);
    if (queryKey !== undefined) void qc.resetQueries({ queryKey, exact: true });
  };
  const setView = (key: string, view: UiView) => {
    const queryKey = keyed.get(key);
    if (queryKey !== undefined) qc.setQueryData(queryKey, view);
  };
  return { states, retry, setView };
}

/**
 * 执行插件视图里的动作（`POST .../ui/actions`）：返回 `{view}` 交给 `onView` 替换，返回 `{toast}` 弹出提示；
 * 失败时抛出带界面文案的 Error（由视图渲染器显示）。
 */
export function useUiAction(
  orgId: string,
  opts: { conversationId?: string; locale: UiLocale; onView(key: string, view: UiView): void },
): (target: ViewTarget) => (req: UiActionRequest) => Promise<void> {
  const { conversationId, locale, onView } = opts;
  const toast = useToast();
  const errorMessage = useErrorMessage();
  // The answer is the new view (`onView`), or a toast: nothing to invalidate.
  const { mutateAsync } = useAppMutation({
    fn: (v: { target: ViewTarget; req: UiActionRequest }) =>
      postUiAction(orgId, v.target.plugin, v.target.id, {
        ...v.req,
        ...(conversationId !== undefined && { conversationId }),
        locale,
      }),
    invalidates: () => [],
  });
  return useCallback(
    (target: ViewTarget) => async (req: UiActionRequest) => {
      let result: Awaited<ReturnType<typeof postUiAction>>;
      try {
        result = await mutateAsync({ target, req });
      } catch (e) {
        throw new Error(errorMessage(e));
      }
      if (result !== undefined && "view" in result) onView(targetKey(target), result.view);
      else if (result?.toast) toast.success(result.toast[locale]);
    },
    [mutateAsync, locale, onView, toast, errorMessage],
  );
}

/** An extension view's content: a skeleton while loading; on failure the error and "Retry" show only here; when ready, the renderer. */
export function ExtensionViewTab({
  state,
  onRetry,
  onAction,
}: {
  state: ViewState | undefined;
  onRetry(): void;
  onAction(req: UiActionRequest): Promise<void>;
}) {
  const t = useTranslations("common");
  const errorMessage = useErrorMessage();
  if (state === undefined || state.kind === "loading") return <Skeleton rows={3} />;
  if (state.kind === "error") {
    return (
      <Stack gap={8}>
        <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
        <Stack direction="row" gap={8}>
          <Button onClick={onRetry}>{t("retry")}</Button>
        </Stack>
      </Stack>
    );
  }
  return <UiViewRenderer view={state.view} onAction={onAction} />;
}
