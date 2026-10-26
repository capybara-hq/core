import { Icon } from "../icons/icon";
import type { MetricProps } from "./basic";

/** At most this many cards (spec §6.14). */
const MAX_STAT_CARDS = 5;

/**
 * The key metrics of a list page as a row of equal-width cards below the PageHeader (spec §5.1,
 * §6.14). More than five throws in development and tests (only logs in production).
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
        <div key={m.label} className="cb-stat-card" data-part="stat-card">
          <div className="cb-stat-label" data-part="stat-label">
            {m.label}
          </div>
          <div className="cb-stat-value" data-part="stat-value" data-tone={m.tone}>
            {m.value}
            {m.delta ? (
              <span className="cb-metric-delta" data-direction={m.delta.direction}>
                <Icon
                  name={m.delta.direction === "up" ? "trending-up" : "trending-down"}
                  size={12}
                />
                {m.delta.value}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
