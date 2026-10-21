"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { findModel, listAgents, listModels, type ProviderModels } from "../lib/agents";
import { ApiClientError } from "../lib/api";
import {
  abortRun,
  type ConversationEvent,
  getConversation,
  listAllEvents,
  type ModelRef,
  postMessage,
} from "../lib/conversations";
import {
  type ChatItem,
  chatItems,
  initialChatState,
  openConversationStream,
  reduceChat,
} from "../lib/stream";
import { type UiRefresh, uiKey } from "../lib/ui";
import { useErrorMessage } from "../lib/use-error-message";
import type { SendResult } from "./Composer";

/** 连接被浏览器放弃后，连续重开订阅的次数上限（期间收到任何事件即清零）。 */
const MAX_REOPEN = 3;

/** {@link useChat} 的结果：页面把消息、输入框与运行状态放进 PlaygroundPage。 */
export type ChatView = {
  items: ChatItem[];
  /** 产出消息的模型是否支持思考（决定是否显示思考区）。 */
  reasoningOf(m: ModelRef): boolean | undefined;
  /** `run_started` 之后、终态事件之前，且不在等人处理。 */
  running: boolean;
  /** 运行在等审批或输入（不是终态；处理后继续）。 */
  waiting: boolean;
  stopping: boolean;
  stop(): void;
  /** 发送（运行中即插话）：`attachments` 为 `@` 资源引用，`files` 为已就绪的上传附件 id。 */
  send(
    text: string,
    clientMessageId: string,
    attachments?: { appId: string; uri: string }[],
    files?: string[],
  ): Promise<SendResult>;
  error: string | undefined;
  /** 会话所属 agent 的名称（取不到时为 undefined）。 */
  agentName: string | undefined;
  /** 已收到的事件（按 seq 升序），供右侧面板的运行 / 上下文标签。 */
  events: ConversationEvent[];
  /** 模型的上下文窗口（模型列表未取到、模型已下线或没有声明时为 undefined）。 */
  contextWindowOf(m: ModelRef): number | undefined;
  /**
   * 插件对话视图的刷新计数：键为 `插件/贡献`，`*` 为全部（事件流重连后，期间可能漏掉刷新）。
   * 计数变了就重新取视图。
   */
  uiVersions: Readonly<Record<string, number>>;
};

/**
 * 对话状态：先读完历史事件，再从最后一条 seq 订阅事件流；事件与增量都交给 {@link reduceChat}。
 * `stop` 调用 abort；`send` 始终可用，运行中发送即为插话。
 */
export function useChat(orgId: string, conversationId: string): ChatView {
  const t = useTranslations("chat");
  const errorMessage = useErrorMessage();
  const [state, dispatch] = useReducer(reduceChat, initialChatState);
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [providers, setProviders] = useState<ProviderModels[]>();
  const [agentName, setAgentName] = useState<string>();
  const [uiVersions, setUiVersions] = useState<Record<string, number>>({});
  const bumpUi = useCallback((key: string) => {
    setUiVersions((v) => ({ ...v, [key]: (v[key] ?? 0) + 1 }));
  }, []);

  // inspector 里的 agent 名称：会话 → agentId → agent 列表；取不到时忽略
  useEffect(() => {
    let disposed = false;
    getConversation(orgId, conversationId)
      .then(async ({ conversation }) => {
        const { agents } = await listAgents(orgId);
        const agent = agents.find((a) => a.id === conversation.agentId);
        if (!disposed && agent) setAgentName(agent.definition.name);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [orgId, conversationId]);

  // 模型列表只用于决定是否显示思考区：取不到时忽略（有思考内容就显示）
  useEffect(() => {
    let disposed = false;
    listModels(orgId).then(
      (r) => {
        if (!disposed) setProviders(r.providers);
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [orgId]);

  const reasoningOf = useCallback(
    (m: ModelRef) =>
      providers === undefined ? undefined : findModel(providers, m)?.capabilities.reasoning,
    [providers],
  );
  const contextWindowOf = useCallback(
    (m: ModelRef) => (providers === undefined ? undefined : findModel(providers, m)?.contextWindow),
    [providers],
  );

  useEffect(() => {
    let disposed = false;
    let close: (() => void) | undefined;
    let failures = 0;
    /**
     * 事件流（及初始历史）送达的最后 seq，重开订阅时作为 `after`。不用 state.lastSeq：
     * POST 返回的事件会先合入 state，若以它为起点会跳过流尚未送达的中间事件。
     */
    let streamSeq = 0;
    /** 首次连接之后的每次连接成功（含浏览器自动重连）：期间可能漏掉 `event: ui`，让插件视图全部重取。 */
    let connected = false;
    const fail = (e: unknown) => {
      if (!disposed) setError(errorMessage(e));
    };
    const open = (after: number) => {
      close = openConversationStream(orgId, conversationId, after, {
        // 每次连接成功（含浏览器自动重连）都清零，空闲会话偶发断线不会累计到上限
        onOpen: () => {
          failures = 0;
          if (connected) bumpUi("*");
          connected = true;
        },
        onUi: (r: UiRefresh) => bumpUi(uiKey(r.plugin, r.contribution)),
        onEvent: (e) => {
          streamSeq = Math.max(streamSeq, e.seq);
          dispatch({ kind: "events", events: [e] });
        },
        onDelta: (d) => dispatch({ kind: "delta", delta: d }),
        onError: ({ code }) => {
          if (disposed) return;
          // 服务端错误帧（会话吊销、失去访问权限等）：不再重连
          if (code !== undefined) return fail(new ApiClientError(0, code, code));
          if (++failures > MAX_REOPEN) return setError(t("streamLost"));
          // 连接被浏览器放弃（多半是 access token 过期，重连得到 401）：经 apiFetch 刷新会话后
          // 从事件流送达的最后一条 seq 重新订阅。
          getConversation(orgId, conversationId).then(() => {
            if (!disposed) open(streamSeq);
          }, fail);
        },
      });
    };
    listAllEvents(orgId, conversationId).then((events) => {
      if (disposed) return;
      dispatch({ kind: "events", events });
      streamSeq = events.at(-1)?.seq ?? 0;
      open(streamSeq);
    }, fail);
    return () => {
      disposed = true;
      close?.();
    };
  }, [orgId, conversationId, errorMessage, t, bumpUi]);

  const onSend = useCallback(
    async (
      text: string,
      clientMessageId: string,
      attachments: { appId: string; uri: string }[] = [],
      files: string[] = [],
    ) => {
      try {
        const { event } = await postMessage(
          orgId,
          conversationId,
          text,
          clientMessageId,
          attachments.map((a) => ({ appId: a.appId, uri: a.uri })),
          files,
        );
        dispatch({ kind: "events", events: [event] });
        setError(undefined);
        return { ok: true as const };
      } catch (e) {
        setError(errorMessage(e));
        return { ok: false as const, error: e };
      }
    },
    [orgId, conversationId, errorMessage],
  );

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await abortRun(orgId, conversationId);
    } catch (e) {
      // 运行恰好已结束：终态事件随后经事件流到达
      if (!(e instanceof ApiClientError && e.code === "run.not_active")) setError(errorMessage(e));
    } finally {
      setStopping(false);
    }
  }, [orgId, conversationId, errorMessage]);

  const items = useMemo(() => chatItems(state), [state]);

  return {
    items,
    reasoningOf,
    running: state.running,
    waiting: state.waiting,
    stopping,
    stop: () => void stop(),
    send: onSend,
    error,
    agentName,
    events: state.events,
    contextWindowOf,
    uiVersions,
  };
}
