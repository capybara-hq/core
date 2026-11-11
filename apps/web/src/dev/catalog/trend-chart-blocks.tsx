import { formatCompact, TrendChart, type TrendChartPanel } from "@capybara-hq/design";
import { TREND_CHART_FIXTURE as F } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// TrendChart (spec §6.8): the admin overview's usage chart, two panels on one x-axis, in its
// states. The blocks have the same ids and boxes as docs/design/reference/src/trend-chart.html.

const W = 720;
const count = (n: number) => n.toLocaleString("en-US");
const compact = (n: number) => formatCompact(n, "zh");
const ZEROS = F.x.map(() => 0);

function panels(
  runs: (number | null)[] = F.runs.values,
  tokens: (number | null)[] = F.tokens.values,
): TrendChartPanel[] {
  return [
    { id: F.runs.id, label: F.runs.label, values: runs, format: count },
    { id: F.tokens.id, label: F.tokens.label, values: tokens, format: compact },
  ];
}

const extra = (i: number) => `${F.costLabel} ${F.cost[i]}`;

function trendChartBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="trend-chart-default" width={W} pad>
        <TrendChart label={F.label} x={F.x} panels={panels()} extra={extra} />
      </RefBlock>
      <RefBlock id="trend-chart-current" width={W} pad>
        <TrendChart label={F.label} x={F.x} panels={panels()} current={F.current} extra={extra} />
      </RefBlock>
      <RefBlock id="trend-chart-hover" width={W} pad>
        <TrendChart
          label={F.label}
          x={F.x}
          panels={panels()}
          current={F.current}
          extra={extra}
          initialActive={F.hover}
        />
      </RefBlock>
      <RefBlock id="trend-chart-empty" width={W} pad>
        <TrendChart
          label={F.label}
          x={F.x}
          panels={panels(ZEROS, ZEROS)}
          current={F.current}
          empty={F.empty}
        />
      </RefBlock>
      <RefBlock id="trend-chart-gap" width={W} pad>
        <TrendChart
          label={F.label}
          x={F.x}
          panels={panels(F.gapRuns, F.gapTokens)}
          current={F.current}
          extra={extra}
        />
      </RefBlock>
      <RefBlock id="trend-chart-phone" width={390} pad>
        <TrendChart label={F.label} x={F.x} panels={panels()} current={F.current} extra={extra} />
      </RefBlock>
    </>
  );
}

export const TREND_CHART_BLOCKS = {
  "trend-chart": trendChartBlocks,
} as const;
