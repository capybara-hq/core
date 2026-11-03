import type { ReactNode } from "react";
import { SkeletonText, StatCards } from "../display/index";
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

/**
 * The header of a loading template (spec §4.2): a title the page does not know yet (an empty
 * string) is a bar; what it knows renders for real. `header.loading` wins when the page sets it.
 */
export function loadingHeader(header: PageHeaderProps): PageHeaderProps {
  return { ...header, loading: header.loading ?? { title: header.title === "" } };
}

/**
 * Stat card placeholders in the loaded card's box (spec §5): the `.cb-stat-card` frame, a `small`
 * label slot and a `metric` value slot.
 */
export function LoadingStats({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="cb-stat-cards" data-part="stat-cards">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <div key={i} className="cb-stat-card" data-part="stat-card">
          <div className="cb-stat-label" data-part="stat-label">
            <SkeletonText width="55%" size="small" />
          </div>
          <div className="cb-stat-value" data-part="stat-value">
            <SkeletonText width="45%" size="metric" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Card-shaped section placeholders (spec §5.2): the `cb-card` panel with its head band (a title
 * slot) and three text lines in the body.
 */
export function LoadingCards({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <section key={i} className="cb-card" data-part="loading-card">
          <header className="cb-card-head">
            <SkeletonText width="30%" />
          </header>
          <div className="cb-card-body cb-loading-stack">
            <SkeletonText width="100%" />
            <SkeletonText width="70%" />
            <SkeletonText width="55%" />
          </div>
        </section>
      ))}
    </>
  );
}

/** The inspector's properties as placeholders: a group title and key / value rows (spec §5.2). */
export function LoadingInspector() {
  return (
    <div className="cb-loading-stack" data-part="loading-inspector">
      <SkeletonText width="30%" size="small" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="cb-loading-row">
          <SkeletonText width="30%" />
          <SkeletonText width="55%" />
        </div>
      ))}
    </div>
  );
}
