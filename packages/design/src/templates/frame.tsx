import type { ReactNode } from "react";
import { StatCards } from "../display/index";
import { PageHeader, type PageHeaderProps } from "../shell/index";

/**
 * The fixed header area of a template (spec §4.2): the PageHeader in a frame of the one content
 * width (`layout.content`, §4.3), so it lines up with the body below it on every page. Templates
 * without a list body (detail, trace, inbox, onboarding, status) draw the header's metrics here as
 * StatCards (`statsInHead`); list and overview pages draw them at the top of the body (WithStats).
 * `loose` leaves space.6 below the header for forms.
 */
export function TemplateHead({
  header,
  statsInHead,
  loose,
  children,
}: {
  header: PageHeaderProps;
  statsInHead?: boolean;
  loose?: boolean;
  /** Drawn under the header inside the same frame (DetailPage's tabs). */
  children?: ReactNode;
}) {
  const metrics = statsInHead ? (header.metrics ?? []) : [];
  return (
    <div className="cb-template-head" data-gap={loose ? "loose" : undefined}>
      <div
        className="cb-template-head-frame"
        data-width="content"
        data-stats={statsInHead ? "head" : undefined}
      >
        <PageHeader {...header} />
        {metrics.length > 0 ? <StatCards metrics={metrics} /> : null}
        {children}
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
