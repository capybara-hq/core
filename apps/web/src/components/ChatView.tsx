"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ApiClientError } from "../lib/api";
import { abortRun, getConversation, listAllEvents, postMessage } from "../lib/conversations";
import { chatItems, initialChatState, openConversationStream, reduceChat } from "../lib/stream";
import { useErrorMessage } from "../lib/use-error-message";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

/** 连接被浏览器放弃后，连续重开订阅的次数上限（期间收到任何事件即清零）。 */
const MAX_REOPEN = 3;

/**
 * 聊天视图：先读完历史事件，再从最后一条 seq 订阅事件流；事件与增量都交给 {@link reduceChat}。
 * 运行中显示「停止」（调用 abort）；输入框始终可用，运行中发送即为插话。
 */
export function ChatView({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const t = useTranslations("chat");
  const errorMessage = useErrorMessage();
  const [state, dispatch] = useReducer(reduceChat, initialChatState);
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let disposed = false;
    let close: (() => void) | undefined;
    let failures = 0;
    /**
     * 事件流（及初始历史）送达的最后 seq，重开订阅时作为 `after`。不用 state.lastSeq：
     * POST 返回的事件会先合入 state，若以它为起点会跳过流尚未送达的中间事件。
     */
    let streamSeq = 0;
    const fail = (e: unknown) => {
      if (!disposed) setError(errorMessage(e));
    };
    const open = (after: number) => {
      close = openConversationStream(orgId, conversationId, after, {
        // 每次连接成功（含浏览器自动重连）都清零，空闲会话偶发断线不会累计到上限
        onOpen: () => {
          failures = 0;
        },
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
  }, [orgId, conversationId, errorMessage, t]);

  const onSend = useCallback(
    async (text: string, clientMessageId: string) => {
      try {
        const { event } = await postMessage(orgId, conversationId, text, clientMessageId);
        dispatch({ kind: "events", events: [event] });
        setError(undefined);
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      }
    },
    [orgId, conversationId, errorMessage],
  );

  async function onStop() {
    setStopping(true);
    try {
      await abortRun(orgId, conversationId);
    } catch (e) {
      // 运行恰好已结束：终态事件随后经事件流到达
      if (!(e instanceof ApiClientError && e.code === "run.not_active")) setError(errorMessage(e));
    } finally {
      setStopping(false);
    }
  }

  const items = useMemo(() => chatItems(state), [state]);

  return (
    <div className="chat">
      <MessageList items={items} />
      {state.running && (
        <div className="row status">
          <span className="muted">{t("running")}</span>
          <button type="button" className="secondary" onClick={onStop} disabled={stopping}>
            {t("stop")}
          </button>
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <Composer onSend={onSend} />
    </div>
  );
}
