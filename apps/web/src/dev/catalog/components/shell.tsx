import {
  ActionRow,
  Grid,
  PageHeader,
  PageTabs,
  StatCards,
  StatusBar,
  StatusMark,
} from "@capybara-hq/design";
import { DETAIL_KPIS, DETAIL_TABS } from "../fixtures";
import { Row, Section } from "../frame";
import { statusFixture } from "../shell-fixture";

const noop = () => {};

/** Spec §4: the App Shell layers on their own (the template routes show them together). */
export function ShellSection() {
  return (
    <Section title="系统布局 App Shell" note="侧栏 | 内容区：页头、内容、操作行、状态栏">
      <Grid columns={1} gap={16}>
        <PageHeader
          breadcrumb={[{ label: "Agents", href: "/dev/ui/templates/list" }]}
          title="support-triage"
          count="v12"
          status={<StatusMark status="success" label="已发布" />}
          description="把工单分到正确的队列，并给出建议回复。"
          actions={[
            { label: "编辑", variant: "default" },
            { label: "试运行", variant: "secondary" },
            { label: "更多操作", menu: [{ label: "复制", onSelect: noop }] },
          ]}
        />
        <StatCards metrics={DETAIL_KPIS} />
        <PageTabs label="Agent 页内导航" items={DETAIL_TABS} value="summary" onChange={noop} />
      </Grid>
      <Row label="ActionRow · 有改动 / 有错误">
        <Grid columns={1}>
          <ActionRow
            unsaved={2}
            errors={1}
            cancel={{ label: "取消", onSelect: noop }}
            secondary={{ label: "保存草稿", shortcut: "⌘S", onSelect: noop }}
            primary={{ label: "发布", onSelect: noop }}
          />
        </Grid>
      </Row>
      <Row label="ActionRow · 提交中">
        <Grid columns={1}>
          <ActionRow
            unsaved={1}
            cancel={{ label: "取消", onSelect: noop }}
            primary={{ label: "发布", loading: true, onSelect: noop }}
          />
        </Grid>
      </Row>
      <Row label="ActionRow · 无改动">
        <Grid columns={1}>
          <ActionRow unsaved={0} primary={{ label: "保存", disabled: true, onSelect: noop }} />
        </Grid>
      </Row>
      <Row label="StatusBar">
        <Grid columns={1}>
          <StatusBar {...statusFixture("/agents/support-triage")} pageStatus="已筛选 18 / 24" />
        </Grid>
      </Row>
    </Section>
  );
}
