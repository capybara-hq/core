import type { ReactNode } from "react";
import { Body, PageHeader, type PageHeaderProps } from "../shell/index.js";

/** T7 调试台：Content（对话 + 输入区）+ Inspector（实时链路）。 */
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
          <div className="cb-playground-thread">{children}</div>
          <div className="cb-playground-composer">{composer}</div>
        </div>
      </Body>
    </div>
  );
}
