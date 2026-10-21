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
}

/** 一个视图的取数进度：每个视图同时至多一个请求在途。 */
interface Run {
  /** 当前要取的版本（组织 / 会话 / 语言 / 刷新计数 / 重试计数）。 */
  want: string;
  /** 最近一次发出的请求对应的版本。 */
  sent: string;
  inflight: boolean;
  /** 发请求用的参数（随最新一次渲染更新）。 */
  args: { orgId: string; plugin: string; id: string; conversationId?: string; locale: UiLocale };
}

/**
 * 取一组插件视图，各自独立：一个失败（慢、抛错、非法视图）只影响它自己的状态（审查重点 1）。
 * `versions` 里 `插件/贡献` 或 `*` 的计数变了就重取对应视图；`retry(key)` 回到加载中再取一次；
 * `setView` 用动作返回的视图直接替换。
 * 刷新合并：每个视图同时至多一个请求在途；在途期间又来的刷新（不论几次）只在它完成后补取一次。
 */
export function usePluginViews(
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
  const targetsKey = targets.map((t) => uiKey(t.plugin, t.id)).join("\n");

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      runs.current = {};
    };
  }, []);

  const start = useCallback((key: string, run: Run) => {
    run.inflight = true;
    run.sent = run.want;
    const { orgId: org, plugin, id, conversationId: conv, locale: lang } = run.args;
    const write = (next: ViewState) => {
      // 发出后又有更新的版本：这次的结果已过时，等补取的那次
      if (live.current && run.sent === run.want) setStates((s) => ({ ...s, [key]: next }));
    };
    getUiView(org, plugin, id, {
      ...(conv !== undefined && { conversationId: conv }),
      locale: lang,
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
      const key = uiKey(tg.plugin, tg.id);
      const want = [
        orgId,
        conversationId ?? "",
        locale,
        versions["*"] ?? 0,
        versions[key] ?? 0,
        retries[key] ?? 0,
      ].join("|");
      const args = {
        orgId,
        plugin: tg.plugin,
        id: tg.id,
        locale,
        ...(conversationId !== undefined && { conversationId }),
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
      if (result !== undefined && "view" in result)
        onView(uiKey(target.plugin, target.id), result.view);
      else if (result?.toast) toast.success(result.toast[locale]);
    },
    [orgId, conversationId, locale, onView, toast, errorMessage],
  );
}

/** 插件视图的内容：加载中骨架；失败时只在这里显示错误与「重试」；就绪时交给渲染器。 */
export function PluginViewTab({
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
