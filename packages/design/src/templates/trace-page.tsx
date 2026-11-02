import type { ReactNode } from "react";
import { Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

/**
 * T8 trace viewer (spec §5): Single in the content width; the span waterfall and the selected span's
 * detail right after it, or, from 1280, the detail as a 400 px right panel inside the width, each
 * column scrolling on its own.
 */
export function TracePage({
  header,
  waterfall,
  detail,
}: {
  header: PageHeaderProps;
  waterfall: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="cb-template" data-template="TracePage" data-width="content">
      <TemplateHead header={header} statsInHead />
      <Body layout="single" width="content">
        <div className="cb-trace">
          <div className="cb-trace-waterfall">{waterfall}</div>
          <div className="cb-trace-detail">{detail}</div>
        </div>
      </Body>
    </div>
  );
}
