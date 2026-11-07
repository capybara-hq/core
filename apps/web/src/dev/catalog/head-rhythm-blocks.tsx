"use client";

import {
  Avatar,
  Card,
  DetailPage,
  Field,
  FormPage,
  FormSection,
  type HeaderAction,
  InboxPage,
  Input,
  KeyValue,
  ListPage,
  ObjectList,
  ObjectRow,
  OverviewPage,
  type PageHeaderProps,
  SettingsPage,
  SpanWaterfall,
  Text,
  TracePage,
  WizardPage,
} from "@capybara-hq/design";
import { PAGE_HEADER_FIXTURE } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { TRACE_SPANS } from "./fixtures";
import { RefBlock } from "./ref-block";

// The head rhythm across the templates (spec §4.2 "Head rhythm", acceptance item S): every block
// draws one template with the same head (path, title, one default action), so the path, the title
// row, the tab row and the body's first block must sit at the same y in each.
// visual/head-rhythm.spec.ts measures them. The box is the 1280-wide content area without the
// sidebar, as the template loading blocks.

const W = 1280;
const H = 480;
const noop = () => {};

const ACTIONS: HeaderAction[] = [{ label: "编辑", variant: "default" }];
const HEAD: PageHeaderProps = {
  path: [{ label: "capybara", href: "/" }, { label: "agents", href: "/" }, { label: "研究助手" }],
  title: "研究助手",
  actions: ACTIONS,
};
const HEAD_TABS: PageHeaderProps = {
  ...HEAD,
  tabs: PAGE_HEADER_FIXTURE.tabs,
  activeTab: "all",
  search: { label: PAGE_HEADER_FIXTURE.search, value: "", onChange: noop },
};
const HEAD_AVATAR: PageHeaderProps = {
  ...HEAD,
  avatar: <Avatar value={{ kind: "preset", id: "capybara" }} name="研究助手" size={40} />,
};
const TABS = {
  label: "页面",
  value: "summary",
  onChange: noop,
  items: [
    { id: "summary", label: "概要" },
    { id: "runs", label: "运行" },
  ],
};
const NAV = [
  {
    group: "智能体",
    items: [
      { id: "basics", label: "基本信息", href: "/" },
      { id: "model", label: "模型", href: "/" },
    ],
  },
];
const ROW = {
  cancel: { label: "取消", onSelect: noop },
  primary: { label: "保存", onSelect: noop },
};

const card: ReactNode = (
  <Card title="概要">
    <Text>研究助手负责检索资料并整理成带出处的摘要。</Text>
  </Card>
);
const section: ReactNode = (
  <FormSection id="basics" title="基本信息" description="名称显示在智能体列表与对话里。">
    <Field label="名称">
      <Input defaultValue="研究助手" />
    </Field>
  </FormSection>
);
const rows: ReactNode = ["研究助手", "周报助手"].map((name) => (
  <ObjectRow key={name} mark={{ text: name }} name={name} description="检索资料并整理" />
));

/** One block per template; `head-rhythm-<state>` matches the spec's state list. */
export function headRhythmBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="head-rhythm-list" width={W} height={H}>
        <ListPage header={HEAD} variant="objects" listLabel="智能体">
          {rows}
        </ListPage>
      </RefBlock>
      <RefBlock id="head-rhythm-list-tabs" width={W} height={H}>
        <ListPage header={HEAD_TABS} variant="objects" listLabel="智能体">
          {rows}
        </ListPage>
      </RefBlock>
      <RefBlock id="head-rhythm-detail" width={W} height={H}>
        <DetailPage
          header={HEAD}
          tabs={TABS}
          facts={<KeyValue rows={[{ k: "模型", v: "claude-sonnet" }]} />}
        >
          {card}
        </DetailPage>
      </RefBlock>
      <RefBlock id="head-rhythm-form" width={W} height={H}>
        <FormPage header={HEAD} actionRow={ROW}>
          {section}
        </FormPage>
      </RefBlock>
      <RefBlock id="head-rhythm-settings" width={W} height={H}>
        <SettingsPage header={HEAD} nav={NAV} activeNav="basics">
          {section}
        </SettingsPage>
      </RefBlock>
      <RefBlock id="head-rhythm-settings-avatar" width={W} height={H}>
        <SettingsPage header={HEAD_AVATAR} nav={NAV} activeNav="basics">
          {section}
        </SettingsPage>
      </RefBlock>
      <RefBlock id="head-rhythm-overview" width={W} height={H}>
        <OverviewPage header={HEAD}>{card}</OverviewPage>
      </RefBlock>
      <RefBlock id="head-rhythm-inbox" width={W} height={H}>
        <InboxPage header={HEAD} list={<ObjectList label="待处理">{rows}</ObjectList>}>
          {card}
        </InboxPage>
      </RefBlock>
      <RefBlock id="head-rhythm-trace" width={W} height={H}>
        <TracePage
          header={HEAD}
          waterfall={
            <SpanWaterfall
              label="Span 瀑布"
              spans={TRACE_SPANS}
              selectedId="s0"
              onSelect={noop}
              labels={{ empty: "这个对话还没有开始过运行。" }}
            />
          }
          detail={card}
        />
      </RefBlock>
      <RefBlock id="head-rhythm-wizard" width={W} height={H}>
        <WizardPage header={HEAD} steps={["选择供应商", "填写凭据"]} current={0} actionRow={ROW}>
          {card}
        </WizardPage>
      </RefBlock>
    </>
  );
}
