/**
 * Mobile-layout fixtures (mobile and foldable layout spec §4–§5, design spec §6.47): the fixed
 * sample data of the ListDetail and sheet reference blocks (docs/design/reference/src), and of the
 * bars those reference screens still draw around them. Pure data, no React. The nav items are the real ones
 * (`apps/web/src/components/shell/nav.tsx`); the names are placeholders (sample org, sample agents, Acme…).
 */

/** The bar the sheet stage's page draws in the reference set (a title and its overflow menu). */
export const TOP_BAR_FIXTURE = {
  rootTitle: "会话",
  pushedTitle: "检索近三年的行业报告",
  back: "返回",
  search: "搜索",
  more: "更多操作",
  overflow: [
    { id: "properties", label: "属性", icon: "panel-right" },
    { id: "agent-map", label: "智能体地图", icon: "agent" },
    { id: "rename", label: "重命名", icon: "square-pen" },
    { id: "copy-link", label: "复制链接", icon: "link" },
    { id: "delete", label: "删除", icon: "trash-2", danger: true },
  ] as { id: string; label: string; icon: string; danger?: boolean }[],
};

/** The list-detail blocks: the inbox's items and the open item's decision (§5.5). */
export const LIST_DETAIL_FIXTURE = {
  listTitle: "收件箱",
  items: [
    {
      id: "ib1",
      title: "需要你批准",
      meta: "Acme 工单: 发送消息 · 研究助手",
      at: "14:02",
      state: "warn",
    },
    {
      id: "ib2",
      title: "需要你批准",
      meta: "Acme 表格: 写入单元格 · 客服分流",
      at: "13:40",
      state: "warn",
    },
    {
      id: "ib3",
      title: "需要你回答",
      meta: "示例表里同一收款人有两行映射",
      at: "11:18",
      state: "warn",
    },
    { id: "ib4", title: "运行完成", meta: "第 43 周团队周报 · 周报助手", at: "10:05" },
    { id: "ib5", title: "运行完成", meta: "Acme 年报摘要 · 研究助手", at: "昨天" },
  ] as { id: string; title: string; meta: string; at: string; state?: "warn" }[],
  /** The open item (the first). */
  detail: {
    title: "需要你批准",
    /** Translated labels only (Channel / Content, never the payload keys `channel` / `text`). */
    facts: [
      { label: "工具", value: "Acme 工单: 发送消息" },
      { label: "键", value: "mcp__acme_tickets__send_message", mono: true },
      { label: "会话", value: "检索近三年的行业报告" },
      { label: "智能体", value: "研究助手" },
      { label: "频道", value: "#示例-支持" },
      { label: "内容", value: "15 条流程已逐条核对完，可以交给你试运行……" },
    ] as { label: string; value: string; mono?: boolean }[],
    /** The primary last: on compact it takes the bottom line alone (§4.4). */
    decisions: [
      { label: "拒绝", variant: "default" },
      { label: "本次会话允许", variant: "default" },
      { label: "允许一次", variant: "primary" },
    ] as { label: string; variant: "primary" | "default" }[],
    back: "返回",
  },
};

/** The sheet drag blocks: a ListPage's filter sheet over the list (§6.7, §7.4 of the layout spec). */
export const SHEET_FIXTURE = {
  title: "筛选",
  close: "关闭",
  handle: "拖动以关闭",
  options: [
    { label: "全部", count: 24, checked: true },
    { label: "已连接", count: 18 },
    { label: "需要授权", count: 4 },
    { label: "出错", count: 2 },
  ] as { label: string; count: number; checked?: boolean }[],
  /** The share of the sheet's height the finger has dragged it down. */
  dragging: 0.24,
  /** Past the 40% dismiss threshold: the release carries it off. */
  settling: 0.6,
  /** The dismiss threshold (the share of the sheet's size). */
  threshold: 0.4,
};
