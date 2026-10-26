import type { ReactNode } from "react";
import type { DesignKey } from "../i18n";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useDesignT } from "../provider";

export function Badge({
  tone = "default",
  children,
}: {
  tone?: "default" | "accent" | "count";
  children?: ReactNode;
}) {
  return (
    <span className="cb-badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children?: ReactNode }) {
  return <kbd className="cb-kbd">{children}</kbd>;
}

export type Status =
  | "running"
  | "success"
  | "failed"
  | "waiting"
  | "queued"
  | "cancelled"
  | "capped";

// Spec §2.4: icon + color (CSS by data-status) + text.
const STATUS_ICON: Record<Status, IconName> = {
  running: "spinner",
  success: "check",
  failed: "circle-x",
  waiting: "pause",
  queued: "circle",
  cancelled: "ban",
  capped: "diamond",
};

export function StatusMark({ status, label }: { status: Status; label?: string }) {
  const t = useDesignT();
  const text = label ?? t(`status.${status}` as DesignKey);
  return (
    <span className="cb-status" data-status={status}>
      <Icon name={STATUS_ICON[status]} size={12} />
      {text}
    </span>
  );
}

export type MetricProps = {
  label: string;
  value: ReactNode;
  delta?: { value: string; direction: "up" | "down" };
  /**
   * Colors the value only (StatCards, spec §6.14): `warn` needs a person, `fail` failed. Success
   * is never colored, and the label says what the value is.
   */
  tone?: "warn" | "fail";
};

export function Metric({ label, value, delta }: MetricProps) {
  return (
    <div className="cb-metric">
      <span className="cb-metric-label">{label}</span>
      <span className="cb-metric-value">
        {value}
        {delta ? (
          <span className="cb-metric-delta" data-direction={delta.direction}>
            <Icon name={delta.direction === "up" ? "trending-up" : "trending-down"} size={12} />
            {delta.value}
          </span>
        ) : null}
      </span>
    </div>
  );
}
