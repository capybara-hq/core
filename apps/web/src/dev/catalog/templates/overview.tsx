import {
  BarChart,
  Card,
  type Column,
  DataTable,
  Grid,
  Metric,
  OverviewPage,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
} from "@capybara-hq/design";
import { LIST_KPIS, RECENT_RUNS, type RecentRun, RUN_TREND, TREND_AXIS } from "../fixtures";
import { FixtureShell } from "../frame";

const COLUMNS: Column<RecentRun>[] = [
  { key: "at", header: "时间", tone: "muted", cell: (r) => r.at },
  { key: "id", header: "RUN", tone: "muted", cell: (r) => r.id },
  { key: "status", header: "状态", cell: (r) => <StatusMark status={r.status} /> },
  { key: "duration", header: "耗时", align: "right", cell: (r) => r.duration },
  { key: "tokens", header: "TOKENS", align: "right", cell: (r) => r.tokens },
];

function OverviewBody() {
  useStatusBar("自动刷新 15s");
  return (
    <OverviewPage header={{ title: "概览" }}>
      <Stack gap={16}>
        <Grid columns={4} gap={16}>
          {LIST_KPIS.map((k) => (
            <Card key={k.label}>
              <Metric {...k} />
            </Card>
          ))}
        </Grid>
        <Grid columns={2} gap={16}>
          <Card title="运行趋势">
            <Stack gap={8}>
              <BarChart label="24 小时运行趋势" series={RUN_TREND} current={RUN_TREND.length - 1} />
              <Stack direction="row" justify="between">
                {TREND_AXIS.map((t) => (
                  <Text key={t} variant="small" tone="faint">
                    {t}
                  </Text>
                ))}
              </Stack>
            </Stack>
          </Card>
          <Card title="待处理">
            <Stack gap={8}>
              <StatusMark status="waiting" label="7 个运行待审批" />
              <StatusMark status="failed" label="41 次失败（24H）" />
              <StatusMark status="running" label="3 个运行中" />
            </Stack>
          </Card>
        </Grid>
        <Card title="最近活动">
          <DataTable<RecentRun>
            label="最近活动"
            framed={false}
            columns={COLUMNS}
            rows={RECENT_RUNS}
            rowKey={(r) => r.id}
          />
        </Card>
      </Stack>
    </OverviewPage>
  );
}

/** T1 概览：组织首页。 */
export function OverviewTemplate() {
  return (
    <FixtureShell nav="overview" context="overview">
      <OverviewBody />
    </FixtureShell>
  );
}
