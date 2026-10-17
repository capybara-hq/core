"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";

/**
 * 输入框：Enter 发送、Shift+Enter 换行。运行中不禁用（此时发送即为插话）；
 * 只在本条消息提交期间禁用发送按钮，避免重复提交。`onSend` 失败时保留输入内容。
 */
export function Composer({ onSend }: { onSend: (text: string) => Promise<boolean> }) {
  const t = useTranslations("chat");
  const id = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  async function submit() {
    const value = text.trim();
    if (value === "" || pending) return;
    setPending(true);
    try {
      if (await onSend(value)) setText("");
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
