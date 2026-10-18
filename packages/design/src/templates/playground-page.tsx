import { type ReactNode, useEffect, useRef } from "react";
import { Body, PageHeader, type PageHeaderProps } from "../shell/index";

/** 距底部不超过该距离（px）视为「在底部」，继续跟随新内容。 */
const FOLLOW_SLACK = 48;

/**
 * 对话区跟随最新消息：挂载时与内容增长时滚到底部；用户上翻离开底部后停止跟随，回到底部附近再恢复。
 * 一律瞬时滚动（不用 smooth）：流式输出时平滑动画会与内容增长互相追赶，也天然满足 prefers-reduced-motion。
 */
function useFollowBottom<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let following = true;
    const toBottom = () => {
      if (following) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      following = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
    };
    toBottom();
    el.addEventListener("scroll", onScroll, { passive: true });
    const mutations = new MutationObserver(toBottom);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    // 视口变矮（窗口缩放、输入区变高）时也保持贴底
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(toBottom);
    resize?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      mutations.disconnect();
      resize?.disconnect();
    };
  }, []);
  return ref;
}

/** T7 调试台：Content（对话 + 输入区）+ Inspector（实时链路）。对话区自动跟随最新消息。 */
export function PlaygroundPage({
  header,
  composer,
  inspector,
  inspectorTitle,
  onInspectorClose,
  children,
}: {
  header: PageHeaderProps;
  composer: ReactNode;
  inspector: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  children?: ReactNode;
}) {
  const thread = useFollowBottom<HTMLDivElement>();
  return (
    <div className="cb-template" data-template="PlaygroundPage">
      <PageHeader {...header} />
      <Body
        layout="inspector"
        inspector={inspector}
        {...(inspectorTitle !== undefined ? { inspectorTitle } : {})}
        {...(onInspectorClose ? { onInspectorClose } : {})}
      >
        <div className="cb-playground">
          <div ref={thread} className="cb-playground-thread">
            {children}
          </div>
          <div className="cb-playground-composer">{composer}</div>
        </div>
      </Body>
    </div>
  );
}
