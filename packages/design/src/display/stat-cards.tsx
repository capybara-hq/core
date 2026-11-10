import type { ReactNode } from "react";
import { Icon } from "../icons/icon";
import { LinkPendingMark, useDesignLink } from "../provider";
import type { MetricProps } from "./basic";

/** At most this many cards (spec §6.14). */
const MAX_STAT_CARDS = 5;

/**
 * The key metrics of a list page as a row of equal-width cards below the PageHeader (spec §5.1,
 * §6.14). More than five throws in development and tests (only logs in production). A metric with
 * `href` links the whole card to its page (hover ground, focus ring).
 */
export function StatCards({ metrics }: { metrics: MetricProps[] }) {
  if (metrics.length > MAX_STAT_CARDS) {
    const msg = `StatCards: metrics must be <= ${MAX_STAT_CARDS}`;
    if (process.env.NODE_ENV === "production") console.error(msg);
    else throw new Error(msg);
  }
  return (
    <div className="cb-stat-cards" data-part="stat-cards">
      {metrics.map((m) => (
        <StatCard key={m.label} metric={m} />
      ))}
    </div>
  );
}

/** One card; with `href` the whole card is a link to the page the number counts. */
function StatCard({ metric: m }: { metric: MetricProps }) {
  const Link = useDesignLink();
  const body: ReactNode = (
    <>
      <div className="cb-stat-label" data-part="stat-label">
        {m.label}
      </div>
      <div className="cb-stat-value" data-part="stat-value" data-tone={m.tone}>
        {m.value}
        {m.delta ? (
          <span className="cb-metric-delta" data-direction={m.delta.direction}>
            <Icon name={m.delta.direction === "up" ? "trending-up" : "trending-down"} size={12} />
            {m.delta.value}
          </span>
        ) : null}
      </div>
    </>
  );
  if (m.href === undefined) {
    return (
      <div className="cb-stat-card" data-part="stat-card" data-cap-part="stat-card">
        {body}
      </div>
    );
  }
  return (
    <Link
      href={m.href}
      className="cb-stat-card"
      data-part="stat-card"
      data-cap-part="stat-card"
      data-link="true"
    >
      {body}
      <LinkPendingMark />
    </Link>
  );
}
