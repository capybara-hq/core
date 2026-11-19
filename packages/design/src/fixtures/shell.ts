/**
 * Mobile-layout fixtures (mobile and foldable layout spec §4–§5, design spec §6.45–§6.48): the fixed
 * sample data of the BottomNav, TopBar, ListDetail, MePanel and sheet reference blocks
 * (docs/design/reference/src). Pure data, no React. The nav items are the real ones
 * (`apps/web/src/components/shell/nav.tsx`); the names are placeholders (sample org, sample agents, Acme…).
 */

/**
 * The compact bottom navigation: exactly four items in this order. `chats` is the icon the
 * BottomNav implementation adds to the icon set (Lucide `messages-square`).
 */
export const BOTTOM_NAV_FIXTURE = {
  label: "主导航",
  items: [
    { id: "chats", label: "会话", href: "/conversations", icon: "chats" },
    { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
    { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox", count: 3 },
    { id: "me", label: "我", href: "/me", icon: "user" },
  ] as { id: string; label: string; href: string; icon: string; count?: number }[],
  /** A count above 99 reads `99+`. */
  countMax: 99,
};

/** The compact top bar: a tab root, a pushed page (a conversation) and its overflow menu. */
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

export type FixtureMeItem = {
  id: string;
  label: string;
  href: string;
  icon: string;
  audience: "all" | "member" | "admin";
};

/** The Me page: what the sidebar's More group holds plus the primary items the bottom nav has no room for. */
export const ME_PANEL_FIXTURE = {
  title: "我",
  more: "更多",
  account: { name: "grant", initial: "G" },
  org: { name: "示例组织", initial: "示", slug: "demo", role: "组织所有者" },
  items: [
    { id: "skills", label: "技能", href: "/skills", icon: "skills", audience: "member" },
    { id: "connectors", label: "连接器", href: "/connectors", icon: "connector", audience: "all" },
    { id: "schedules", label: "定时任务", href: "/schedules", icon: "clock", audience: "member" },
    { id: "devices", label: "设备", href: "/devices", icon: "cpu", audience: "all" },
    { id: "plugins", label: "插件", href: "/plugins", icon: "catalog", audience: "member" },
    { id: "extensions", label: "扩展", href: "/extensions", icon: "extension", audience: "member" },
    { id: "channels", label: "渠道", href: "/channels", icon: "channel", audience: "admin" },
    { id: "evals", label: "评测与运行", href: "/evals", icon: "evals", audience: "admin" },
    {
      id: "settings",
      label: "组织设置",
      href: "/settings/organization",
      icon: "settings",
      audience: "member",
    },
  ] as FixtureMeItem[],
  adminEntry: { label: "管理后台", href: "/admin", icon: "admin" },
  accountGroup: "账户",
  accountItems: [
    { id: "account", label: "个人设置", href: "/account", icon: "user" },
    { id: "language", label: "语言", icon: "languages", value: "简体中文" },
    { id: "theme", label: "主题", icon: "sun" },
    { id: "sign-out", label: "退出登录", icon: "log-out" },
  ] as { id: string; label: string; href?: string; icon: string; value?: string }[],
  /** The StatusBar's system line, which compact has no room for (§4). */
  system: "系统正常 · v0.1.0 · UTC+8",
  /** The roles a block draws, by what the sidebar shows each (design spec §6.13). */
  visible: {
    member: ["all", "member"],
    admin: ["all", "member", "admin"],
    "super-admin": ["all", "member", "admin"],
  } as Record<"member" | "admin" | "super-admin", string[]>,
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
    facts: [
      ["工具", "Acme 工单: 发送消息"],
      ["键", "mcp__acme_tickets__send_message"],
      ["会话", "检索近三年的行业报告"],
      ["智能体", "研究助手"],
      ["channel", "#示例-支持"],
      ["text", "15 条流程已逐条核对完，可以交给你试运行……"],
    ] as [string, string][],
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
