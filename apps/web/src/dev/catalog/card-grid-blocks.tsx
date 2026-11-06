import { CardGrid, ObjectCard, type ObjectCardProps } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// CardGrid and ObjectCard (spec §6.34, ruling P4-15): the blocks have the same ids and boxes as
// docs/design/reference/src/card-grid.html. A block 1088 wide with the `space.4` padding holds
// the content width (1056): three columns of 344.

const noop = () => {};
const W = 1088;

const AGENT_MENU = [
  { label: "设置", onSelect: noop },
  { label: "运行记录", onSelect: noop },
  { label: "更改所有者", onSelect: noop },
];

/** The workspace 智能体 tab's cards (ruling P4-16): owner · 可见范围, 开始会话, ⋯. */
export const AGENT_CARDS: ObjectCardProps[] = [
  {
    avatar: { kind: "preset", id: "capybara" },
    title: "研究助手",
    href: "#research",
    description: "帮你检索资料、整理笔记，并按需生成带引用的摘要。",
    meta: ["grant", "仅自己"],
    primary: { label: "开始会话", onSelect: noop },
    menu: AGENT_MENU,
  },
  {
    avatar: { kind: "preset", id: "owl" },
    title: "周报助手",
    href: "#weekly",
    description: "每周五汇总团队的提交和会议纪要，写成周报草稿。",
    meta: ["lin", "全组织"],
    primary: { label: "开始会话", onSelect: noop },
    menu: AGENT_MENU,
  },
  {
    avatar: { kind: "preset", id: "penguin" },
    title: "客服助手",
    href: "#support",
    description: "回答产品常见问题，复杂工单转给值班同事。",
    meta: ["grant", "指定成员"],
    primary: { label: "开始会话", onSelect: noop },
    menu: AGENT_MENU,
  },
  {
    avatar: null,
    title: "翻译助手",
    href: "#translate",
    description: "中英互译，保留术语表里的译法。",
    meta: ["chen", "仅自己"],
    primary: { label: "开始会话", onSelect: noop },
    menu: AGENT_MENU,
  },
  {
    avatar: { kind: "preset", id: "fox" },
    title: "代码审查",
    href: "#review",
    description: "读合并请求的改动，按团队规范逐条提出意见。",
    meta: ["lin", "全组织"],
    primary: { label: "开始会话", onSelect: noop },
    menu: AGENT_MENU,
  },
];

const LONG: ObjectCardProps[] = [
  {
    avatar: { kind: "preset", id: "whale" },
    title: "跨部门季度经营分析与预算编制助手（财务共享中心专用版）",
    href: "#long",
    description:
      "读取财务系统导出的明细账和预算表，按部门、项目和科目汇总本季度的收入、成本与费用，对比预算找出偏差较大的条目并说明原因，再按管理层模板生成季度经营分析报告和下季度预算建议，所有数字都附上来源表格和计算过程。",
    meta: ["finance-shared-services-admin", "指定成员", { label: "连接器待配置", tone: "warn" }],
    primary: { label: "开始会话", onSelect: noop },
    menu: AGENT_MENU,
  },
  AGENT_CARDS[1] as ObjectCardProps,
  AGENT_CARDS[2] as ObjectCardProps,
];

const TEMPLATE_MENU = [
  { label: "查看", onSelect: noop },
  { label: "编辑", onSelect: noop },
];

/** Template cards without a description (ruling P4-16): source · version, 用它创建, ⋯. */
const TEMPLATES: ObjectCardProps[] = [
  {
    avatar: { icon: "file-text" },
    title: "周报模板",
    href: "#t-weekly",
    meta: ["平台", "v3"],
    primary: { label: "用它创建", onSelect: noop },
    menu: TEMPLATE_MENU,
  },
  {
    avatar: { kind: "preset", id: "rabbit" },
    title: "招聘初筛",
    href: "#t-hiring",
    meta: ["本组织", "v1"],
    primary: { label: "用它创建", onSelect: noop },
    menu: TEMPLATE_MENU,
  },
  {
    avatar: { icon: "file-text" },
    title: "合同审阅",
    href: "#t-contract",
    meta: ["superpowers", "v2"],
    primary: { label: "用它创建", onSelect: noop },
    menu: [{ label: "查看", onSelect: noop }],
  },
];

function grid(label: string, cards: ObjectCardProps[]) {
  return (
    <CardGrid label={label}>
      {cards.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed catalog cards
        <ObjectCard key={i} {...c} />
      ))}
    </CardGrid>
  );
}

function cardGridBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="card-grid-default" width={W} pad>
        {grid("智能体", AGENT_CARDS)}
      </RefBlock>
      {/* A long name keeps one line, a long description two, a long meta one; all with their tooltips. */}
      <RefBlock id="card-grid-long-text" width={W} pad>
        {grid("智能体", LONG)}
      </RefBlock>
      <RefBlock id="card-grid-no-description" width={W} pad>
        {grid("模板", TEMPLATES)}
      </RefBlock>
      <RefBlock id="card-grid-loading" width={W} pad>
        <CardGrid label="智能体" loading />
      </RefBlock>
      <RefBlock id="card-grid-empty" width={W} pad>
        <CardGrid
          label="智能体"
          empty={{
            text: "还没有智能体",
            hint: "从模板创建一个，或新建一个空白智能体。",
            action: { label: "新建智能体", variant: "primary", icon: "plus", onSelect: noop },
          }}
        />
      </RefBlock>
      {/* A phone window: one column, the primary and the menu are 40 px tap targets. */}
      <RefBlock id="card-grid-narrow" width={390} pad>
        {grid("智能体", AGENT_CARDS.slice(0, 2))}
      </RefBlock>
    </>
  );
}

export const CARD_GRID_BLOCKS = {
  "card-grid": cardGridBlocks,
} as const;
