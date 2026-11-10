import {
  ActionRow,
  DecorationLayer,
  Grid,
  PageHeader,
  ReplaceableFrame,
  SafeModeBanner,
  StatCards,
  StatusBar,
  StatusMark,
  Text,
} from "@capybara-hq/design";
import { DETAIL_KPIS } from "../fixtures";
import { Row, Section } from "../frame";
import { statusFixture } from "../shell-fixture";

const noop = () => {};

/** Spec §4: the App Shell layers on their own (the template routes show them together). */
export function ShellSection() {
  return (
    <Section title="系统布局 App Shell" note="侧栏 | 内容区：页头、内容、操作行、状态栏">
      <Grid columns={1} gap={16}>
        <PageHeader
          path={[
            { label: "capybara", href: "/dev/ui" },
            { label: "agents", href: "/dev/ui/templates/list" },
            { label: "support-triage" },
          ]}
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
      <Row label="SafeModeBanner">
        <Grid columns={1}>
          <SafeModeBanner onExit={noop} />
        </Grid>
      </Row>
      <Row label="ReplaceableFrame · 已就绪 / 等待替换（隐藏但保留占位）">
        <Grid columns={2}>
          <ReplaceableFrame pending={false}>
            <Text>内置内容</Text>
          </ReplaceableFrame>
          <ReplaceableFrame pending>
            <Text>内置内容</Text>
          </ReplaceableFrame>
        </Grid>
      </Row>
      <Row label="DecorationLayer（全视口、aria-hidden、不拦截指针；此处无可见内容）">
        <DecorationLayer>
          <span data-cap-interactive="true" />
        </DecorationLayer>
      </Row>
    </Section>
  );
}
