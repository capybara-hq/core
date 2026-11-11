/**
 * The one fixtures module (`@capybara-hq/design/fixtures`): fixed sample data shared by `/dev/ui`
 * and the reference set (docs/design/reference). Pure data, no React. The copy is placeholder only
 * (示例组织, 研究助手, Acme…), never names from real work (UI refresh spec §9), and is not product
 * copy, so it does not go through i18n.
 */
import type { IconName } from "../icons/paths";

export const FIXTURE_ORG = "示例组织";
export const FIXTURE_USER = { name: "grant", initial: "G" };

// ── Sidebar ─────────────────────────────────────────────────────────────────

export type FixtureNavItem = {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  count?: number;
  audience: "all" | "member" | "admin" | "superAdmin";
  /**
   * After New conversation (`primary`), inside the 更多 flyout (`more`), or an icon button in the
   * brand row (`brand`: the inbox).
   */
  place: "primary" | "more" | "brand";
};

/**
 * The work context's navigation in the web-order spec §2.1 order, as apps/web draws it (acceptance
 * 2026-11-07: no home item; 智能体, 技能, 连接器 after New conversation, the rest in the 更多 flyout,
 * extension pages after 更多's).
 */
export const NAV_FIXTURE: FixtureNavItem[] = [
  {
    id: "inbox",
    label: "收件箱",
    href: "/inbox",
    icon: "inbox",
    count: 3,
    audience: "all",
    place: "brand",
  },
  {
    id: "agents",
    label: "智能体",
    href: "/agents",
    icon: "agent",
    audience: "all",
    place: "primary",
  },
  {
    id: "skills",
    label: "技能",
    href: "/skills",
    icon: "skills",
    audience: "member",
    place: "primary",
  },
  {
    id: "connectors",
    label: "连接器",
    href: "/connectors",
    icon: "connector",
    audience: "all",
    place: "primary",
  },
  {
    id: "plugins",
    label: "插件",
    href: "/plugins",
    icon: "catalog",
    audience: "member",
    place: "more",
  },
  {
    id: "extensions",
    label: "扩展",
    href: "/extensions",
    icon: "extension",
    audience: "member",
    place: "more",
  },
  {
    id: "channels",
    label: "渠道",
    href: "/channels",
    icon: "channel",
    audience: "admin",
    place: "more",
  },
  {
    id: "evals",
    label: "评测与运行",
    href: "/evals",
    icon: "evals",
    audience: "admin",
    place: "more",
  },
  {
    id: "settings",
    label: "组织设置",
    href: "/settings/organization",
    icon: "settings",
    audience: "member",
    place: "more",
  },
];

/** The org switcher: the current org, `~/<slug> · <role>`. */
export const ORG_SWITCHER_FIXTURE = {
  name: FIXTURE_ORG,
  initial: "示",
  slug: "demo",
  role: "组织所有者",
};

/** The admin context's items (web-order spec §2.2). */
export const ADMIN_NAV_FIXTURE: { id: string; label: string; href: string; icon: IconName }[] = [
  { id: "overview", label: "概览", href: "/admin", icon: "gauge" },
  { id: "accounts", label: "账号", href: "/admin/accounts", icon: "user" },
  { id: "orgs", label: "组织", href: "/admin/orgs", icon: "building" },
  { id: "extensions", label: "扩展", href: "/admin/extensions", icon: "extension" },
  { id: "catalog", label: "平台目录", href: "/admin/catalog", icon: "catalog" },
  { id: "marketplaces", label: "市场", href: "/admin/marketplaces", icon: "store" },
  { id: "models", label: "模型", href: "/admin/models", icon: "cpu" },
  { id: "settings", label: "部署设置", href: "/admin/settings", icon: "sliders" },
];

/** The archived entry's count (`已归档 · 7`). */
export const ARCHIVED_COUNT_FIXTURE = 7;

export const NEW_CONVERSATION_LABEL = "新会话";
export const MORE_LABEL = "更多";
export const ADMIN_LABEL = "管理后台";

/** One step of the setup sidebar (web-SSR spec §4); the catalog adds the links. */
export type FixtureSetupStep = {
  id: string;
  label: string;
  state: "done" | "todo" | "waiting";
  reason?: string;
  optional?: boolean;
};

/**
 * The setup sidebar's steps (web-SSR spec §4, per role): a super admin who is also an org
 * admin, after the model (done, an agent to create, the optional steps), and a member before any
 * model (both steps waiting with their reasons, one optional step).
 */
export const SETUP_STEPS_FIXTURE: Record<"admin" | "member", FixtureSetupStep[]> = {
  admin: [
    { id: "model", label: "配置模型", state: "done" },
    { id: "agent", label: "新建智能体", state: "todo" },
    { id: "channels", label: "连接渠道", state: "todo", optional: true },
    { id: "members", label: "邀请成员", state: "todo", optional: true },
    { id: "catalog", label: "安装插件", state: "todo", optional: true },
  ],
  member: [
    { id: "model", label: "配置模型", state: "waiting", reason: "等待管理员配置模型" },
    { id: "agent", label: "新建智能体", state: "waiting", reason: "先配置模型" },
    { id: "connections", label: "我的连接", state: "todo", optional: true },
  ],
};

/** The setup sidebar's own copy (design i18n `sidebar.setup*`, `sidebar.step*`). */
export const SETUP_COPY = {
  home: "开始之前",
  later: "可以稍后再做",
  done: "已完成",
  todo: "未完成",
  waiting: "等待中",
};

/** Extension pages: the 更多 group lists them after its fixed items. */
export const EXTENSION_PAGES_FIXTURE: { id: string; label: string; href: string }[] = [
  { id: "board", label: "任务看板", href: "/p/example-board/board" },
  { id: "todo", label: "待办清单", href: "/p/todo/list" },
];

export type FixtureConversation = {
  id: string;
  title: string | null;
  startedAt: string;
  updatedAt: string;
  /** A state dot: running (ok) or waiting for me (warn). */
  activity?: "running" | "waiting";
};
export type FixtureGroup = {
  agentId: string;
  agentName: string;
  conversations: FixtureConversation[];
  more: boolean;
};

const conv = (
  id: string,
  title: string | null,
  at: string,
  activity?: "running" | "waiting",
): FixtureConversation => ({
  id,
  title,
  startedAt: `2026-10-${at}:00+08:00`,
  updatedAt: `2026-10-${at}:00+08:00`,
  ...(activity ? { activity } : {}),
});

/** The default conversation section: the first group has more than it shows. */
export const GROUPS_FIXTURE: FixtureGroup[] = [
  {
    agentId: "agt_research",
    agentName: "研究助手",
    conversations: [
      conv("cnv_r1", "整理 Q3 竞品调研要点", "24T16:20", "waiting"),
      conv("cnv_r2", "检索近三年的行业报告", "24T11:05"),
      conv("cnv_r3", "对比三家云厂商的定价", "23T18:42", "running"),
      conv("cnv_r4", "Acme 年报摘要", "22T09:30"),
      conv("cnv_r5", "用户访谈记录归类", "21T15:12"),
    ],
    more: true,
  },
  {
    agentId: "agt_support",
    agentName: "客服分流",
    conversations: [conv("cnv_s1", "退款工单自动分类规则", "24T10:18", "waiting")],
    more: false,
  },
  {
    agentId: "agt_weekly",
    agentName: "周报助手",
    conversations: [
      conv("cnv_w1", "第 43 周团队周报", "23T17:00"),
      conv("cnv_w2", null, "20T14:32"),
    ],
    more: false,
  },
];

/** The conversation shown as current in the sidebar blocks. */
export const ACTIVE_CONVERSATION_ID = "cnv_r2";

/** The placeholder for a conversation without a title: `未命名会话 · MM-DD HH:mm`. */
export const UNTITLED_CONVERSATION = "未命名会话";

/** A 48-character CJK title and a 30-character agent name, with no spaces (Review Focus 1). */
export const LONG_TITLE_GROUP_FIXTURE: FixtureGroup = {
  agentId: "agt_long",
  agentName: "跨部门季度经营分析与年度预算编制及执行情况跟踪复盘总结小助手",
  conversations: [
    conv(
      "cnv_l1",
      "请根据上一季度各事业部提交的经营数据汇总表逐项核对收入成本费用并给出差异原因分析和改进建议清单。",
      "24T09:00",
    ),
    conv("cnv_l2", "核对预算执行偏差", "23T09:00"),
  ],
  more: false,
};

const MANY_AGENTS = [
  "研究助手",
  "客服分流",
  "周报助手",
  "合同初审",
  "招聘筛选",
  "数据看板",
  "会议纪要",
  "代码评审",
  "发布说明",
  "知识库问答",
  "工单升级",
  "销售线索",
  "采购比价",
  "差旅报销",
  "培训问答",
  "舆情摘要",
  "接口巡检",
  "日志分析",
  "翻译校对",
  "活动策划",
];

/** 20 groups of one conversation each; the API has more groups to page in. */
export const MANY_GROUPS_FIXTURE: FixtureGroup[] = MANY_AGENTS.map((agentName, i) => ({
  agentId: `agt_many_${i + 1}`,
  agentName,
  conversations: [conv(`cnv_m${i + 1}`, `${agentName}的最近一次会话`, "24T08:00")],
  more: false,
}));
export const MANY_GROUPS_MORE = true;

export const SIDEBAR_COPY = {
  search: "搜索",
  searchShortcut: "⌘K",
  newConversationIn: "与 {agent} 新建会话",
  more: "显示更多",
  moreGroups: "更多分组",
  empty: "还没有会话",
  error: "会话列表加载失败",
  retry: "重试",
  expand: "展开侧栏",
  collapse: "收起侧栏",
  menu: "打开导航",
  account: FIXTURE_USER.name,
  conversations: "会话",
  filter: "筛选会话",
  filterQuery: "按标题搜索",
  states: ["全部", "运行中", "等待我"],
  noMatch: "没有匹配的会话",
  clearFilter: "清除筛选",
  archived: "已归档",
  adminScope: "整个部署 · /admin",
  back: "回到工作区",
};

// ── List page (connectors) ──────────────────────────────────────────────────

export type FixtureMetric = { label: string; value: string; tone?: "warn" | "fail" };
export type FixtureConnectorStatus = "connected" | "needs-auth" | "error" | "disabled";
export type FixtureConnectorRow = {
  id: string;
  name: string;
  description: string;
  type: "MCP" | "OpenAPI";
  status: FixtureConnectorStatus;
  tools: number;
  calls7d: string;
  owner: string;
};

export const CONNECTOR_STATUS_LABEL: Record<FixtureConnectorStatus, string> = {
  connected: "已连接",
  "needs-auth": "需要授权",
  error: "出错",
  disabled: "已停用",
};

export const LIST_PAGE_FIXTURE: {
  title: string;
  description: string;
  primaryAction: string;
  secondaryAction: string;
  metrics: FixtureMetric[];
  metricsFive: FixtureMetric[];
  searchPlaceholder: string;
  chips: { label: string; count: number }[];
  sort: string;
  columns: {
    name: string;
    type: string;
    status: string;
    tools: string;
    calls7d: string;
    owner: string;
  };
  rows: FixtureConnectorRow[];
  pagination: string;
  empty: { title: string; action: string };
  rowActions: string;
} = {
  title: "连接器",
  description: "把 MCP、OpenAPI 等外部服务接进来，智能体就能调用它们的工具。",
  primaryAction: "添加连接器",
  secondaryAction: "导入",
  metrics: [
    { label: "已接入", value: "24" },
    { label: "需要授权", value: "2", tone: "warn" },
    { label: "出错", value: "1", tone: "fail" },
    { label: "7 天调用", value: "18,402" },
  ],
  metricsFive: [
    { label: "已接入", value: "24" },
    { label: "需要授权", value: "2", tone: "warn" },
    { label: "出错", value: "1", tone: "fail" },
    { label: "7 天调用", value: "18,402" },
    { label: "工具总数", value: "131" },
  ],
  searchPlaceholder: "搜索名称或工具",
  chips: [
    { label: "全部", count: 24 },
    { label: "MCP", count: 15 },
    { label: "OpenAPI", count: 9 },
    { label: "需要处理", count: 3 },
  ],
  sort: "按最近调用排序",
  columns: {
    name: "名称",
    type: "类型",
    status: "状态",
    tools: "工具",
    calls7d: "7 天调用",
    owner: "所有者",
  },
  rows: [
    {
      id: "con_docs",
      name: "Acme Docs",
      description: "检索与引用产品文档",
      type: "MCP",
      status: "connected",
      tools: 18,
      calls7d: "6,210",
      owner: "grant",
    },
    {
      id: "con_sheets",
      name: "示例表格",
      description: "读写表格与公式",
      type: "MCP",
      status: "connected",
      tools: 9,
      calls7d: "4,877",
      owner: "张三",
    },
    {
      id: "con_ledger",
      name: "示例账务",
      description: "凭证、科目与余额查询",
      type: "OpenAPI",
      status: "needs-auth",
      tools: 32,
      calls7d: "—",
      owner: "李四",
    },
    {
      id: "con_tickets",
      name: "示例工单",
      description: "查询与更新工单",
      type: "MCP",
      status: "connected",
      tools: 14,
      calls7d: "2,931",
      owner: "王五",
    },
    {
      id: "con_bank",
      name: "Acme Pay",
      description: "账户流水与对账单",
      type: "OpenAPI",
      status: "error",
      tools: 11,
      calls7d: "1,204",
      owner: "李四",
    },
    {
      id: "con_wiki",
      name: "内部 Wiki",
      description: "页面检索与摘要",
      type: "MCP",
      status: "connected",
      tools: 7,
      calls7d: "980",
      owner: "grant",
    },
    {
      id: "con_crm",
      name: "旧版 CRM",
      description: "客户与合同档案",
      type: "OpenAPI",
      status: "disabled",
      tools: 21,
      calls7d: "0",
      owner: "—",
    },
  ],
  pagination: "共 24 个 · 第 1 / 4 页",
  empty: { title: "没有匹配的连接器", action: "清除筛选" },
  rowActions: "更多操作",
};

/** Row ids for the table's hover and selected blocks. */
export const TABLE_HOVER_ROW = "con_tickets";
export const TABLE_SELECTED_ROW = "con_sheets";

// ── Form page (edit agent) ──────────────────────────────────────────────────

export type FixtureFormField =
  | { kind: "input"; id: string; label: string; value: string; error?: string; optional?: boolean }
  | {
      kind: "textarea";
      id: string;
      label: string;
      value: string;
      focus?: boolean;
      mono?: boolean;
      counter?: string;
      optional?: boolean;
    }
  | { kind: "select"; id: string; label: string; value: string }
  | { kind: "segmented"; id: string; label: string; options: string[]; selected: number }
  | {
      kind: "switches";
      id: string;
      rows: { name: string; description: string; policy: string; on: boolean }[];
    };

export const FORM_PAGE_FIXTURE: {
  path: { label: string; href?: string }[];
  title: string;
  sections: { title: string; description: string; fields: FixtureFormField[] }[];
  actionRow: { unsaved: string; errors: string; discard: string; save: string; clean: string };
  status: { context: string; pageStatus: string };
} = {
  path: [
    { label: "capybara", href: "/" },
    { label: "agents", href: "/agents" },
    { label: "研究助手" },
  ],
  title: "编辑智能体",
  sections: [
    {
      title: "基本信息",
      description: "成员在会话列表和新建会话时看到的名字与说明。",
      fields: [
        {
          kind: "input",
          id: "name",
          label: "名称",
          value: "研究助手",
          error: "组织里已经有一个叫「研究助手」的智能体。",
        },
        {
          kind: "textarea",
          id: "description",
          label: "说明",
          value: "检索资料、整理要点并给出来源。",
          focus: true,
          optional: true,
        },
      ],
    },
    {
      title: "模型",
      description: "改模型会生成新版本，已经开始的会话不受影响。",
      fields: [
        { kind: "select", id: "model", label: "模型", value: "model-large" },
        {
          kind: "segmented",
          id: "effort",
          label: "思考档位",
          options: ["低", "中等", "高", "最高"],
          selected: 1,
        },
        {
          kind: "textarea",
          id: "system",
          label: "系统提示词",
          value:
            "You are the research assistant for 示例组织.\nCollect sources, summarize key points and cite every claim.\nNever share internal documents outside the org.",
          mono: true,
          counter: "148 / 8,000",
        },
      ],
    },
    {
      title: "工具与审批",
      description: "关掉的工具模型看不到；需要审批的工具每次调用前都会问人。",
      fields: [
        {
          kind: "switches",
          id: "tools",
          rows: [
            { name: "Bash", description: "在沙箱里运行命令", policy: "自动", on: true },
            {
              name: "mcp__acme_docs__search",
              description: "检索产品文档",
              policy: "自动",
              on: true,
            },
            {
              name: "mcp__tickets__update",
              description: "更新工单状态",
              policy: "需要审批",
              on: true,
            },
            {
              name: "mcp__ledger__post_entry",
              description: "过账记账凭证",
              policy: "已关闭",
              on: false,
            },
          ],
        },
      ],
    },
  ],
  actionRow: {
    unsaved: "2 处未保存的修改",
    errors: "1 个错误",
    discard: "放弃修改",
    save: "保存",
    clean: "没有未保存的修改",
  },
  status: {
    context: `${FIXTURE_USER.name}@${FIXTURE_ORG}:/agents/研究助手/edit`,
    pageStatus: "当前版本 v12",
  },
};

// ── Page header, status bar, controls ───────────────────────────────────────

export const PAGE_HEADER_FIXTURE = {
  title: "Agents",
  pathTitle: "编辑智能体",
  /** The views and the search of a list page's tab row (the narrow block, spec §4.2). */
  tabs: [
    { id: "all", label: "全部", count: 6 },
    { id: "mine", label: "我的", count: 3 },
    { id: "shared", label: "组织共享", count: 3 },
  ],
  search: "搜索名称或模型",
  longTitle:
    "季度经营分析与预算执行跟踪复盘助手的全部历史版本与发布记录以及每个版本的变更说明和审批意见汇总页面",
};

export const STATUS_FIXTURE = {
  context: `${FIXTURE_USER.name}@${FIXTURE_ORG}:/connectors`,
  pageStatus: "已筛选 24 / 24",
  system: "系统正常",
  version: "v0.1.0",
  timeZone: "UTC+8",
};

export const CONTROLS_FIXTURE = {
  buttons: [
    { variant: "primary", label: "新建智能体" },
    { variant: "secondary", label: "部署" },
    { variant: "default", label: "导出" },
    { variant: "ghost", label: "取消" },
    { variant: "danger", label: "删除" },
  ] as const,
  iconButton: "更多操作",
  loading: "保存中",
  input: { label: "名称", value: "研究助手", placeholder: "输入名称", error: "名称不能为空。" },
  segments: ["1H", "24H", "7D", "30D"],
  switchLabel: "在沙箱里运行",
  switchOn: "已开启",
  switchOff: "已关闭",
};

/**
 * The form Select's reference blocks (spec §6.2): one field with three options; the long list
 * (`long`) is LONG_MODELS_FIXTURE's 100 models with its selected one.
 */
export const SELECT_FIXTURE = {
  label: "可见范围",
  options: [
    { value: "private", label: "仅自己" },
    { value: "org", label: "组织内所有成员" },
    { value: "public", label: "公开" },
  ],
  value: "org",
  placeholder: "选择可见范围",
  error: "请选择可见范围。",
  longLabel: "模型",
};

export * from "./conversation";

/**
 * A plugin icon for the catalog and the reference set (spec §6.17, maintainer decision 2026-11-08):
 * a monochrome svg as a data URI, standing in for a kernel icon route.
 */
export const PLUGIN_ICON_FIXTURE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='2' y='2' width='20' height='20' rx='5'/%3E%3Cpath d='M7 12h10M12 7v10' stroke='white' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E";

/**
 * The overview section's reference blocks (spec §5.6 "OverviewSection"): a section of the admin
 * overview (待处理) with its rows, the loading shape (the rows' list), and the in-place error
 * (a sentence, the raw text behind 原始错误).
 */
export const OVERVIEW_SECTION_FIXTURE = {
  title: "待处理",
  action: "查看全部",
  rows: [
    { id: "requests", title: "扩展权限审批", meta: "2 个扩展等待批准", count: "2" },
    { id: "updates", title: "可更新的插件", meta: "crm v1.2.0 → v1.3.0", count: "1" },
    { id: "providers", title: "模型供应商", meta: "deepseek 无法列出模型", count: "1" },
  ],
  loadingItems: 3,
  errorSummary: "无法加载待处理事项。",
  errorDetail: "GET /api/admin/attention: 503 Service Unavailable (upstream timed out after 10s)",
};

/**
 * The trend chart's reference blocks (spec §6.8 "TrendChart"): the admin overview's 用量 · 近 7 天
 * (admin overview design §6.3): two panels, 运行 (count) and Token (compact), sharing the seven
 * dates; today (the last point) is the current one; the cost is the tooltip's extra line.
 */
export const TREND_CHART_FIXTURE = {
  label: "近 7 天用量",
  x: [
    { key: "2026-11-05", label: "11-05" },
    { key: "2026-11-06", label: "11-06" },
    { key: "2026-11-07", label: "11-07" },
    { key: "2026-11-08", label: "11-08" },
    { key: "2026-11-09", label: "11-09" },
    { key: "2026-11-10", label: "11-10" },
    { key: "2026-11-11", label: "11-11" },
  ],
  runs: { id: "runs", label: "运行", values: [96, 132, 118, 87, 128, 112, 64] },
  tokens: {
    id: "tokens",
    label: "Token",
    values: [2_410_000, 3_120_000, 2_870_000, 1_960_000, 3_400_000, 3_050_000, 1_520_000],
  },
  /** The gap block: no data for 11-07 and 11-08 (null, drawn as a gap). */
  gapRuns: [96, 132, null, null, 128, 112, 64] as (number | null)[],
  gapTokens: [2_410_000, 3_120_000, null, null, 3_400_000, 3_050_000, 1_520_000] as (
    | number
    | null
  )[],
  cost: ["¥9.80", "¥12.10", "¥11.40", "¥7.60", "¥12.30", "¥11.90", "¥5.90"],
  costLabel: "估算",
  current: 6,
  /** The index the hover block shows (11-09, the highest day). */
  hover: 4,
  empty: "近 7 天没有运行。",
};
