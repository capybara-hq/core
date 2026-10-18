"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, type KeyboardEvent, useId, useRef, useState } from "react";

/**
 * `clientMessageId`：`crypto.randomUUID` 只在安全上下文可用（HTTPS / localhost），
 * 其余情况用 `getRandomValues` 生成同等随机度的 id。
 */
function newClientMessageId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 输入框：Enter 发送、Shift+Enter 换行。运行中不禁用（此时发送即为插话）；
 * 只在本条消息提交期间禁用发送按钮，避免重复提交。`onSend` 失败时保留输入内容。
 *
 * 每条待发送的草稿持有一个 `clientMessageId`：发送失败（网络错误、5xx、响应丢失）后重试沿用同一个 id，
 * 内核据此去重，不会在只追加的日志里写出重复的 user_message；发送成功或文本改动后才换新 id。
 */
export function Composer({
  onSend,
}: {
  onSend: (text: string, clientMessageId: string) => Promise<boolean>;
}) {
  const t = useTranslations("chat");
  const id = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  /** 当前草稿的 id 及其对应的文本（文本变了就作废）。 */
  const draft = useRef<{ text: string; id: string } | undefined>(undefined);

  async function submit() {
    const value = text.trim();
    if (value === "" || pending) return;
    if (draft.current?.text !== value) draft.current = { text: value, id: newClientMessageId() };
    const clientMessageId = draft.current.id;
    setPending(true);
    try {
      if (await onSend(value, clientMessageId)) {
        draft.current = undefined;
        setText("");
      }
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void submit();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <label htmlFor={`${id}-input`} className="visually-hidden">
        {t("inputLabel")}
      </label>
      <textarea
        id={`${id}-input`}
        name="message"
        rows={3}
        placeholder={t("placeholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" disabled={pending || text.trim() === ""}>
        {t("send")}
      </button>
    </form>
  );
}
