import type { ReactNode } from "react";
import { StatCards } from "../display/index";
import { PageHeader, type PageHeaderProps } from "../shell/index";

export type ContentWidth = "list" | "form" | "full";

/**
 * The fixed header area of a template (spec §4.2): the PageHeader in a frame of the page's content
 * width, so it lines up with the body below it. Full-width templates (detail, trace, inbox,
 * playground) draw the header's metrics here as StatCards; list and overview pages draw them at
 * the top of the body (WithStats).
 */
export function TemplateHead({ header, width }: { header: PageHeaderProps; width: ContentWidth }) {
  const metrics = width === "full" ? (header.metrics ?? []) : [];
  return (
    <div className="cb-template-head" data-width={width}>
      <div className="cb-template-head-frame" data-width={width}>
        <PageHeader {...header} />
        {metrics.length > 0 ? <StatCards metrics={metrics} /> : null}
      </div>
    </div>
  );
}

/** The header's metrics as StatCards above the page content (spec §5.1), when there are any. */
export function WithStats({ header, children }: { header: PageHeaderProps; children?: ReactNode }) {
  const metrics = header.metrics ?? [];
  return (
    <>
      {metrics.length > 0 ? <StatCards metrics={metrics} /> : null}
      {children}
    </>
  );
}
