import type { JSX } from "react";
import { Tooltip } from "../display/tooltip";
import { useDesignT } from "../provider";
import { fillCopy } from "./tool-copy";

// The composer's context meter (layered shell spec §6): a small ring before send / stop showing how
// much of the context window the conversation has used. It is a `control.dense` square, so it never
// changes the control row's height; geometry is in a 24-unit viewBox that scales to that square.

const BOX = 24;
const STROKE = 2;
const RADIUS = (BOX - STROKE) / 2 - 4;

/** The ring: track `line`, arc `muted`, `fail` once `over`. The tooltip is also its accessible name. */
export function ContextMeter({ pct, over }: { pct: number; over?: boolean }): JSX.Element {
  const t = useDesignT();
  const value = Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)));
  const label = fillCopy(t("composer.contextUsed"), { n: value });
  return (
    <Tooltip content={label} side="top">
      {/* biome-ignore lint/a11y/useSemanticElements: a <meter> can't draw the ring */}
      <svg
        className="cb-context-meter"
        data-part="composer-context-meter"
        data-tone={over ? "fail" : undefined}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        viewBox={`0 0 ${BOX} ${BOX}`}
      >
        <circle
          className="cb-context-meter-track"
          cx={BOX / 2}
          cy={BOX / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
        />
        <circle
          className="cb-context-meter-arc"
          cx={BOX / 2}
          cy={BOX / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
          pathLength={100}
          strokeDasharray={`${value} ${100 - value}`}
        />
      </svg>
    </Tooltip>
  );
}
