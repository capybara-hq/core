"use client";

import { Button, Skeleton, Stack, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../lib/api";
import {
  getUiView,
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
}

/** The state key of a target. */
export const targetKey = (t: ViewTarget) => t.key ?? uiKey(t.plugin, t.id);

/** 一个视图的取数进度：每个视图同时至多一个请求在途。 */
interface Run {
  /** 当前要取的版本（组织 / 会话 / 语言 / 刷新计数 / 重试计数）。 */
  want: string;
  /** 最近一次发出的请求对应的版本。 */
  sent: string;
  inflight: boolean;
  /** 发请求用的参数（随最新一次渲染更新）。 */
  args: {
    orgId: string;
    plugin: string;
    id: string;
    conversationId?: string;
    locale: UiLocale;
    item?: string;
    card?: { callId: string; key?: string };
  };
  /** Aborts the request in flight when the view goes away. */
  ctrl?: AbortController;
}

/**
 * Loads a set of extension views independently: one failing (slow, throwing, an invalid view) only
 * affects its own state (review focus 1). When the count for `extension/contribution` or `*` in
 * `versions` changes, the matching view is fetched again; `retry(key)` goes back to loading and
 * fetches once more; `setView` replaces a view with the one an action returned.
 * Refresh coalescing: at most one request per view is in flight; refreshes arriving meanwhile (any
 * number) cause one more fetch after it completes.
 */
export function useExtensionViews(
  orgId: string,
  targets: readonly ViewTarget[],
  opts: { conversationId?: string; locale: UiLocale; versions?: Readonly<Record<string, number>> },
): {
  states: Readonly<Record<string, ViewState>>;
  retry(key: string): void;
  setView(key: string, view: UiView): void;
} {
  const { conversationId, locale } = opts;
  const versions = opts.versions ?? NO_VERSIONS;
  const [states, setStates] = useState<Record<string, ViewState>>({});
  const [retries, setRetries] = useState<Record<string, number>>({});
  const runs = useRef<Record<string, Run>>({});
  const live = useRef(true);
  const targetsKey = targets.map(targetKey).join("\n");

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const r of Object.values(runs.current)) r.ctrl?.abort();
      runs.current = {};
    };
  }, []);

  const start = useCallback((key: string, run: Run) => {
    run.inflight = true;
    run.sent = run.want;
    const { orgId: org, plugin, id, conversationId: conv, locale: lang, item, card } = run.args;
    const ctrl = new AbortController();
    run.ctrl = ctrl;
    const write = (next: ViewState) => {
      // 发出后又有更新的版本：这次的结果已过时，等补取的那次
      if (live.current && run.sent === run.want) setStates((s) => ({ ...s, [key]: next }));
    };
    getUiView(org, plugin, id, {
      ...(conv !== undefined && { conversationId: conv }),
      locale: lang,
      ...(item !== undefined && { item }),
      ...(card !== undefined && { card }),
      signal: ctrl.signal,
    })
      .then(
        ({ view }) => write({ kind: "ready", view }),
        (e: unknown) =>
          write({ kind: "error", code: e instanceof ApiClientError ? e.code : "unknown" }),
      )
      .finally(() => {
        run.inflight = false;
        if (live.current && runs.current[key] === run && run.sent !== run.want) start(key, run);
      });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: targets 以 targetsKey 表示
  useEffect(() => {
    for (const tg of targets) {
      const key = targetKey(tg);
      const want = [
        orgId,
        conversationId ?? "",
        locale,
        versions["*"] ?? 0,
        versions[uiKey(tg.plugin, tg.id)] ?? 0,
        retries[key] ?? 0,
      ].join("|");
      const args = {
        orgId,
        plugin: tg.plugin,
        id: tg.id,
        locale,
        ...(conversationId !== undefined && { conversationId }),
        ...(tg.item !== undefined && { item: tg.item }),
        ...(tg.card !== undefined && { card: tg.card }),
      };
      let run = runs.current[key];
      if (run === undefined) {
        run = { want, sent: "", inflight: false, args };
        runs.current[key] = run;
      }
      run.want = want;
      run.args = args;
      // 在途：完成后由 finally 补取（多次刷新只补一次）
      if (run.inflight || run.sent === want) continue;
      start(key, run);
    }
  }, [targetsKey, orgId, conversationId, locale, versions, retries, start]);

  const retry = useCallback((key: string) => {
    setStates((s) => ({ ...s, [key]: { kind: "loading" } }));
    setRetries((r) => ({ ...r, [key]: (r[key] ?? 0) + 1 }));
  }, []);
  const setView = useCallback((key: string, view: UiView) => {
    setStates((s) => ({ ...s, [key]: { kind: "ready", view } }));
  }, []);
  return { states, retry, setView };
}

const NO_VERSIONS: Readonly<Record<string, number>> = {};

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
  return useCallback(
    (target: ViewTarget) => async (req: UiActionRequest) => {
      let result: Awaited<ReturnType<typeof postUiAction>>;
      try {
        result = await postUiAction(orgId, target.plugin, target.id, {
          ...req,
          ...(conversationId !== undefined && { conversationId }),
          locale,
        });
      } catch (e) {
        throw new Error(errorMessage(e));
      }
      if (result !== undefined && "view" in result) onView(targetKey(target), result.view);
      else if (result?.toast) toast.success(result.toast[locale]);
    },
    [orgId, conversationId, locale, onView, toast, errorMessage],
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
