import type { ReactNode } from "react";
import { Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead, WithStats } from "./frame";

/** T1 Overview: Single, list width. */
export function OverviewPage({
  header,
  children,
}: {
  header: PageHeaderProps;
  children?: ReactNode;
}) {
  return (
    <div className="cb-template" data-template="OverviewPage" data-width="list">
      <TemplateHead header={header} width="list" />
      <Body layout="single" width="list">
        <WithStats header={header}>{children}</WithStats>
      </Body>
    </div>
  );
}
