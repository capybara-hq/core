import type { ReactNode } from "react";
import {
  ActionRow,
  type ActionRowProps,
  Body,
  PageHeader,
  type PageHeaderProps,
} from "../shell/index";

/** T2 列表：Rail + Content；无 rail 时退化为 Single。 */
export function ListPage({
  header,
  rail,
  actionRow,
  children,
}: {
  header: PageHeaderProps;
  rail?: ReactNode;
  actionRow?: ActionRowProps;
  children?: ReactNode;
}) {
  return (
    <div className="cb-template" data-template="ListPage">
      <PageHeader {...header} />
      <Body layout={rail != null ? "rail" : "single"} rail={rail}>
        {children}
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
