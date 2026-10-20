import { type Ref, useCallback, useEffect, useRef } from "react";

/** 固定的沙箱：允许脚本与表单，不给同源（嵌入页拿不到外层的 cookie / storage / DOM）。 */
export const EMBED_SANDBOX = "allow-scripts allow-forms";

export type EmbedFrameProps = {
  src: string;
  /** iframe 的可访问名称。 */
  title: string;
  /** 高度（px），默认 360。由调用方根据嵌入页的 resize 消息更新。 */
  height?: number;
  /** 只收到 `event.source === 本 iframe 的 contentWindow` 的 message；内容由调用方解析校验。 */
  onMessage(e: MessageEvent): void;
  /** 拿到 iframe 元素，用于 `frameRef.current?.contentWindow?.postMessage(...)`。 */
  frameRef?: Ref<HTMLIFrameElement>;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/**
 * 插件嵌入页（spec §6.9）。整个界面里唯一渲染 iframe 的地方：apps/web 不得自己写 iframe。
 * sandbox 固定为 `allow-scripts allow-forms`，不可由调用方放宽。
 */
export function EmbedFrame({ src, title, height = 360, onMessage, frameRef }: EmbedFrameProps) {
  const own = useRef<HTMLIFrameElement | null>(null);
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });

  const setRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      own.current = el;
      assignRef(frameRef, el);
    },
    [frameRef],
  );

  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const win = own.current?.contentWindow;
      if (!win || e.source !== win) return;
      handler.current(e);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  return (
    <iframe
      ref={setRef}
      className="cb-embed"
      src={src}
      title={title}
      height={Math.max(0, Math.round(height))}
      sandbox={EMBED_SANDBOX}
      referrerPolicy="no-referrer"
    />
  );
}
