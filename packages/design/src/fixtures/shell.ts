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
  /**
   * Who sees the row: the workspace rows as the sidebar's `audience` (nav.tsx); every manage row
   * is for org admins and owners (design spec §6.48).
   */
  audience: "all" | "member" | "admin";
  group: "workspace" | "manage";
};

/**
 * The Me page (design spec §6.48): the workspace group (the primary items the bottom nav has no
 * room for, and devices) and the manage group (the sidebar's other More items, then the admin
 * console entry for super admins).
 */
export const ME_PANEL_FIXTURE = {
  title: "我",
  groups: { workspace: "工作区", manage: "管理" } as Record<"workspace" | "manage", string>,
  account: { name: "grant", initial: "G" },
  org: { name: "示例组织", initial: "示", slug: "demo", role: "组织所有者" },
  items: [
    {
      id: "skills",
      label: "技能",
      href: "/skills",
      icon: "skills",
      audience: "member",
      group: "workspace",
    },
    {
      id: "connectors",
      label: "连接器",
      href: "/connectors",
      icon: "connector",
      audience: "all",
      group: "workspace",
    },
    {
      id: "schedules",
      label: "定时任务",
      href: "/schedules",
      icon: "clock",
      audience: "member",
      group: "workspace",
    },
    {
      id: "devices",
      label: "设备",
      href: "/devices",
      icon: "cpu",
      audience: "all",
      group: "workspace",
    },
    {
      id: "plugins",
      label: "插件",
      href: "/plugins",
      icon: "catalog",
      audience: "admin",
      group: "manage",
    },
    {
      id: "extensions",
      label: "扩展",
      href: "/extensions",
      icon: "extension",
      audience: "admin",
      group: "manage",
    },
    {
      id: "channels",
      label: "渠道",
      href: "/channels",
      icon: "channel",
      audience: "admin",
      group: "manage",
    },
    {
      id: "evals",
      label: "评测与运行",
      href: "/evals",
      icon: "evals",
      audience: "admin",
      group: "manage",
    },
    {
      id: "settings",
      label: "组织设置",
      href: "/settings/organization",
      icon: "settings",
      audience: "admin",
      group: "manage",
    },
  ] as FixtureMeItem[],
  adminEntry: { label: "管理后台", href: "/admin", icon: "admin" },
  /**
   * The admin context (design spec §6.48): a short sample of the console's pages in the manage
   * group, the back row last; the context block replaces the org switcher.
   */
  adminContext: {
    block: { label: "管理后台", meta: "整个部署 · /admin", icon: "admin" },
    items: [
      { id: "overview", label: "概览", href: "/admin", icon: "gauge" },
      { id: "accounts", label: "账号", href: "/admin/accounts", icon: "user" },
      { id: "orgs", label: "组织", href: "/admin/orgs", icon: "building" },
      { id: "extensions", label: "扩展", href: "/admin/extensions", icon: "extension" },
      { id: "models", label: "模型", href: "/admin/models", icon: "cpu" },
      { id: "settings", label: "部署设置", href: "/admin/settings", icon: "sliders" },
    ] as { id: string; label: string; href: string; icon: string }[],
    back: { id: "back", label: "回到工作区", href: "/", icon: "arrow-left" },
  },
  accountGroup: "账户",
  accountItems: [
    { id: "account", label: "个人设置", href: "/account", icon: "user" },
    { id: "language", label: "语言", icon: "languages", value: "简体中文" },
    { id: "theme", label: "主题", icon: "sun" },
    { id: "sign-out", label: "退出登录", icon: "log-out" },
  ] as { id: string; label: string; href?: string; icon: string; value?: string }[],
  /** The StatusBar's system line, which compact has no room for (§4). */
  system: "系统正常 · v0.1.0 · UTC+8",
  /**
   * The audiences each block draws. The super-admin block is an org member who is a super admin:
   * the workspace rows and, in the manage group, only the admin console entry.
   */
  visible: {
    member: ["all", "member"],
    admin: ["all", "member", "admin"],
    "super-admin": ["all", "member"],
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
