import type { ReactNode } from "react";
import { Body, type PageHeaderProps } from "../shell/index";
import { useFollowBottom } from "./follow-bottom";
import { TemplateHead } from "./frame";

/**
 * @deprecated Replaced by {@link ConversationPage} (UI refresh B); removed once the conversation
 * page moves over (plan Task 19).
 *
 * T7 调试台：Content（对话 + 输入区）+ Inspector（实时链路）。对话区自动跟随最新消息。 */
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
    <div className="cb-template" data-template="PlaygroundPage" data-width="full">
      <TemplateHead header={header} width="full" />
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
