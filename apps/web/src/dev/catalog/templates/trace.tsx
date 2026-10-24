import {
  Card,
  Grid,
  IoBlock,
  KeyValue,
  SpanWaterfall,
  Stack,
  StatusMark,
  Text,
  TracePage,
  useStatusBar,
} from "@capybara-hq/design";
import { useState } from "react";
import { TRACE_SPANS } from "../fixtures";
import { FixtureShell } from "../frame";

function TraceBody() {
  useStatusBar("· 已加载 1 次运行");
  const [active, setActive] = useState<string | null>("t1");
  return (
    <TracePage
      header={{
        parent: { label: "运行记录", href: "/dev/ui/table" },
        title: "退款工单 A1043",
        status: <StatusMark status="running" />,
        metrics: [
          { label: "总 TOKEN", value: "12,408" },
          { label: "成本（估算）", value: "0.0412 USD" },
          { label: "调用数", value: "6" },
          { label: "耗时", value: "6.8s" },
        ],
        actions: [{ label: "加入评测集", variant: "default" }],
      }}
      waterfall={
        <SpanWaterfall
          label="Span 瀑布"
          spans={TRACE_SPANS}
          selectedId={active}
          onSelect={setActive}
          labels={{ empty: "这个对话还没有开始过运行。" }}
        />
      }
      detail={
        <Stack gap={12}>
          <Text variant="small" tone="muted">
            查看运行记录会记入审计。
          </Text>
          <Card title="工具调用 · crm__refund_order">
            <Stack gap={12}>
              <Grid columns={2} gap={16}>
                <IoBlock label="IN" text={'{\n  "order": "A1043",\n  "amount": 620\n}'} />
                <IoBlock label="OUT" text={'{\n  "refunded": true\n}'} />
              </Grid>
              <KeyValue
                keyWidth="16ch"
                rows={[
                  { k: "耗时", v: "300ms" },
                  { k: "请求审批", v: "10-18 14:02:12" },
                  { k: "决定", v: "已批准" },
                  { k: "范围", v: "仅本次" },
                  { k: "处理人", v: "acc_zhang" },
                ]}
              />
            </Stack>
          </Card>
        </Stack>
      }
    />
  );
}

/** T8 链路查看器：上方 Span 瀑布，下方选中 span 的详情。 */
export function TraceTemplate() {
  return (
    <FixtureShell nav="runs" context="runs/run_8f2k1x">
      <TraceBody />
    </FixtureShell>
  );
}
