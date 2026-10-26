import type { ReactNode } from "react";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead, WithStats } from "./frame";

/** T2 List: Rail + Content (Single without a rail), list width; StatCards from `metrics`. */
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
    <div className="cb-template" data-template="ListPage" data-width="list">
      <TemplateHead header={header} width="list" />
      <Body layout={rail != null ? "rail" : "single"} rail={rail} width="list">
        <WithStats header={header}>{children}</WithStats>
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
