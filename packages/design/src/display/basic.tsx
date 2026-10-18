import type { ReactNode } from "react";
import type { DesignKey } from "../i18n";
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

export type Status = "running" | "success" | "failed" | "waiting" | "queued" | "cancelled";

// spec §2.4：符号 + 颜色（CSS 按 data-status）+ 文字
const GLYPH: Record<Status, string> = {
  running: "●",
  success: "✓",
  failed: "✗",
  waiting: "‖",
  queued: "○",
  cancelled: "⊘",
};

export function StatusMark({ status, label }: { status: Status; label?: string }) {
  const t = useDesignT();
  const text = label ?? t(`status.${status}` as DesignKey);
  return (
    <span className="cb-status" data-status={status}>
      {`${GLYPH[status]} ${text}`}
    </span>
  );
}

export type MetricProps = {
  label: string;
  value: ReactNode;
  delta?: { value: string; direction: "up" | "down" };
};

export function Metric({ label, value, delta }: MetricProps) {
  return (
    <div className="cb-metric">
      <span className="cb-metric-label">{label}</span>
      <span className="cb-metric-value">
        {value}
        {delta ? (
          <span className="cb-metric-delta" data-direction={delta.direction}>
            {`${delta.direction === "up" ? "▲" : "▼"}${delta.value}`}
          </span>
        ) : null}
      </span>
    </div>
  );
}
