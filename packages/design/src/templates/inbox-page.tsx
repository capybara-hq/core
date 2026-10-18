import type { ReactNode } from "react";
import {
  ActionRow,
  type ActionRowProps,
  Body,
  PageHeader,
  type PageHeaderProps,
} from "../shell/index";

/** T6 收件箱：Rail（列表）+ Content (+ Inspector)；决策时出现 ActionRow。 */
export function InboxPage({
  header,
  list,
  inspector,
  inspectorTitle,
  onInspectorClose,
  actionRow,
  children,
}: {
  header: PageHeaderProps;
  list: ReactNode;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  actionRow?: ActionRowProps;
  children?: ReactNode;
}) {
  return (
    <div className="cb-template" data-template="InboxPage">
      <PageHeader {...header} />
      <Body
        layout={inspector != null ? "rail-inspector" : "rail"}
        rail={list}
        inspector={inspector}
        {...(inspectorTitle !== undefined ? { inspectorTitle } : {})}
        {...(onInspectorClose ? { onInspectorClose } : {})}
      >
        {children}
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
