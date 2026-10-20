"use client";

import { Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { readToolOutput } from "../../lib/conversations";
import type { ChatItem } from "../../lib/stream";
import { useErrorMessage } from "../../lib/use-error-message";
import { ToolCallCard } from "../ToolCallCard";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

type Archived = { text: string; complete: boolean };

/** 存档输出的缓存与读取状态（{@link useArchivedOutputs}）。 */
export interface ArchivedOutputs {
  /** 存档 id → 取到的全文。 */
  archived: Record<string, Archived>;
  /** 正在读取的存档 id。 */
  loading: ReadonlySet<string>;
  /** 读取某个存档的全文；已取到或正在读取时什么也不做。 */
  load(outputId: string): void;
}

/**
 * 运行标签「查看全部输出」取到的全文：放在对话面板（ChatPanel）的组件状态里，切换标签不丢、不重取；
 * 换了对话就清空。同一存档在途时再点不会重复请求（同步的 ref 守卫，防连点）。只在本浏览器标签页的内存里。
 */
export function useArchivedOutputs(orgId: string, conversationId: string): ArchivedOutputs {
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const scope = `${orgId}/${conversationId}`;
  type State = { scope: string; archived: Record<string, Archived>; loading: ReadonlySet<string> };
  const empty = (): State => ({ scope, archived: {}, loading: new Set() });
  const [state, setState] = useState<State>(empty);
  /** 在途的 `<scope>/<存档 id>`：同步判定，连点时第二次点击看得到第一次（状态更新是异步的）。 */
  const inFlight = useRef(new Set<string>());
  const current = state.scope === scope ? state : empty();

  const load = useCallback(
    (outputId: string) => {
      const key = `${scope}/${outputId}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      // 换了对话之后才回来的结果丢掉（scope 不同）
      const update = (fn: (s: State) => State) => setState((s) => (s.scope === scope ? fn(s) : s));
      const settle = (s: State, archived = s.archived): State => {
        const loading = new Set(s.loading);
        loading.delete(outputId);
        return { ...s, archived, loading };
      };
      setState((s) => {
        const base = s.scope === scope ? s : { scope, archived: {}, loading: new Set<string>() };
        return { ...base, loading: new Set([...base.loading, outputId]) };
      });
      readToolOutput(orgId, conversationId, outputId)
        .then(
          (r) => update((s) => settle(s, { ...s.archived, [outputId]: r })),
          (e: unknown) => {
            update((s) => settle(s));
            toast.error(errorMessage(e));
          },
        )
        .finally(() => inFlight.current.delete(key));
    },
    [orgId, conversationId, scope, toast, errorMessage],
  );
  return { archived: current.archived, loading: current.loading, load };
}

/**
 * 运行标签：本对话的工具调用（来自日志里的 assistant_message / tool_call_started / tool_result），
 * 每条点开在面板里看完整的 IN / OUT。内核截断并存档的输出，点「查看全部输出」经存档接口
 * （`GET .../conversations/:id/outputs/:outputId`）取全文；全文缓存在面板（`outputs`），读取中按钮显示「读取中」。
 */
export function RunTab({ tools, outputs }: { tools: ToolItem[]; outputs: ArchivedOutputs }) {
  const t = useTranslations("chatPanel");
  if (tools.length === 0) return <Text tone="muted">{t("runEmpty")}</Text>;
  return (
    <Stack gap={4}>
      {tools.map((item) => {
        const id = item.outputId;
        const got = id === null ? undefined : outputs.archived[id];
        return (
          <ToolCallCard
            key={item.key}
            item={item}
            full
            {...(got !== undefined && { archived: got })}
            {...(id !== null && {
              onShowAll: () => outputs.load(id),
              ...(outputs.loading.has(id) && { showAllLabel: t("loadingOutput") }),
            })}
          />
        );
      })}
    </Stack>
  );
}
