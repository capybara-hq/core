import {
  ActionRow,
  Grid,
  PageHeader,
  PageTabs,
  StatusBar,
  StatusMark,
  TopBar,
} from "@capybara-hq/design";
import { DETAIL_KPIS, DETAIL_TABS, shellStatus, topBar } from "../fixtures";
import { Row, Section } from "../frame";

const noop = () => {};

/** spec §4：App Shell 各层单独展示（模板路由里是完整组合）。 */
export function ShellSection() {
  return (
    <Section title="系统布局 App Shell" note="每个页面自上而下都是这几层，顺序固定">
      <Grid columns={1} gap={8}>
        <TopBar {...topBar("agents")} />
        <PageHeader
          parent={{ label: "Agents", href: "/dev/ui/templates/list" }}
          title="support-triage"
          count="v12"
          status={<StatusMark status="success" label="已发布" />}
          metrics={DETAIL_KPIS}
          actions={[
            { label: "编辑", variant: "default" },
            { label: "▶ 试运行", variant: "secondary" },
            { label: "更多操作", menu: [{ label: "复制", onSelect: noop }] },
          ]}
        />
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
      <Row label="StatusBar">
        <Grid columns={1}>
          <StatusBar {...shellStatus("agents/support-triage")} pageStatus="· 已筛选 18 / 24" />
        </Grid>
      </Row>
    </Section>
  );
}
