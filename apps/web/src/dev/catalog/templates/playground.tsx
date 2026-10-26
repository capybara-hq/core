import {
  Button,
  Card,
  PlaygroundPage,
  Stack,
  StatusMark,
  Text,
  Textarea,
  useStatusBar,
} from "@capybara-hq/design";
import { useState } from "react";
import { TRACE_LINES } from "../fixtures";
import { FixtureShell } from "../frame";

function PlaygroundBody() {
  useStatusBar("运行中 00:00:18");
  const [draft, setDraft] = useState("");
  return (
    <PlaygroundPage
      header={{
        breadcrumb: [{ label: "support-triage", href: "/dev/ui/templates/detail" }],
        title: "试运行",
        status: <StatusMark status="running" />,
        actions: [{ label: "清空对话", variant: "default" }],
      }}
      inspectorTitle="实时链路"
      inspector={
        <Stack gap={8}>
          <Text variant="small" tone="muted">
            实时链路
          </Text>
          {TRACE_LINES.map((l) => (
            <Stack key={l.at} gap={0}>
              <Stack direction="row" gap={8}>
                <Text variant="small" tone="muted">
                  {l.at}
                </Text>
                <StatusMark status={l.status} label={l.kind} />
                {l.ms ? (
                  <Text variant="small" tone="faint">
                    {l.ms}
                  </Text>
                ) : null}
              </Stack>
              <Text variant="small">{l.text}</Text>
            </Stack>
          ))}
        </Stack>
      }
      composer={
        <Stack direction="row" gap={8} align="end">
          <Textarea
            aria-label="消息"
            placeholder="输入消息，⌘↵ 发送"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button variant="primary" shortcut="⌘↵">
            发送
          </Button>
        </Stack>
      }
    >
      <Stack gap={12}>
        <Card title="用户">
          <Text>订单 A1043 的耳机有杂音，申请退款 ¥820。</Text>
        </Card>
        <Card title="support-triage">
          <Text>
            已确认订单与退款政策。金额超过 ¥500，已提交人工审批，审批通过后会自动回复客户。
          </Text>
        </Card>
      </Stack>
    </PlaygroundPage>
  );
}

/** T7 调试台：试运行 support-triage。 */
export function PlaygroundTemplate() {
  return (
    <FixtureShell nav="agents" context="agents/support-triage/playground">
      <PlaygroundBody />
    </FixtureShell>
  );
}
