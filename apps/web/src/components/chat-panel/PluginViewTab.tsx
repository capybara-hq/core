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

/**
 * 取一组插件视图，各自独立：一个失败（慢、抛错、非法视图）只影响它自己的状态（审查重点 1）。
 * `versions` 里 `插件/贡献` 或 `*` 的计数变了就重取对应视图；`retry(key)` 回到加载中再取一次；
 * `setView` 用动作返回的视图直接替换。
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
  /** 每个视图最近一次取数的标识：只有最新那次的结果能写回（旧请求晚到时丢弃）。 */
  const tokens = useRef<Record<string, string>>({});
  const live = useRef(true);
  const targetsKey = targets.map((t) => uiKey(t.plugin, t.id)).join("\n");

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      tokens.current = {};
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: targets 以 targetsKey 表示
  useEffect(() => {
    for (const tg of targets) {
      const key = uiKey(tg.plugin, tg.id);
      const token = [
        orgId,
        conversationId ?? "",
        locale,
        versions["*"] ?? 0,
        versions[key] ?? 0,
        retries[key] ?? 0,
      ].join("|");
      if (tokens.current[key] === token) continue;
      tokens.current[key] = token;
      const current = () => live.current && tokens.current[key] === token;
      getUiView(orgId, tg.plugin, tg.id, {
        ...(conversationId !== undefined && { conversationId }),
        locale,
      }).then(
        ({ view }) => {
          if (current()) setStates((s) => ({ ...s, [key]: { kind: "ready", view } }));
        },
        (e: unknown) => {
          const code = e instanceof ApiClientError ? e.code : "unknown";
          if (current()) setStates((s) => ({ ...s, [key]: { kind: "error", code } }));
        },
      );
    }
  }, [targetsKey, orgId, conversationId, locale, versions, retries]);

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
