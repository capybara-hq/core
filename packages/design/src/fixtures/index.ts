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
  audience: "all" | "member" | "admin" | "enterprise";
};

/** Top-level navigation in spec §4.4 order (the Extensions group sits between Evals and Settings). */
export const NAV_FIXTURE: FixtureNavItem[] = [
  { id: "overview", label: "概览", href: "/", icon: "home", audience: "all" },
  { id: "agents", label: "Agents", href: "/agents", icon: "agent", audience: "all" },
  { id: "skills", label: "技能", href: "/skills", icon: "skills", audience: "member" },
  { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox", count: 3, audience: "all" },
  { id: "connectors", label: "连接器", href: "/connectors", icon: "connector", audience: "all" },
  { id: "catalog", label: "企业目录", href: "/catalog", icon: "catalog", audience: "member" },
  { id: "channels", label: "渠道", href: "/channels", icon: "channel", audience: "admin" },
  { id: "evals", label: "评测", href: "/evals", icon: "evals", audience: "admin" },
  { id: "settings", label: "设置", href: "/settings", icon: "settings", audience: "all" },
  { id: "admin", label: "管理", href: "/admin", icon: "admin", audience: "enterprise" },
];

export const NEW_CONVERSATION_LABEL = "新会话";
export const EXTENSIONS_LABEL = "扩展";

export const EXTENSION_PAGES_FIXTURE: { id: string; label: string; href: string }[] = [
  { id: "board", label: "任务看板", href: "/p/example-board/board" },
  { id: "todo", label: "待办清单", href: "/p/todo/list" },
];

export type FixtureConversation = {
  id: string;
  title: string | null;
  startedAt: string;
  updatedAt: string;
};
export type FixtureGroup = {
  agentId: string;
  agentName: string;
  conversations: FixtureConversation[];
  more: boolean;
};

const conv = (id: string, title: string | null, at: string): FixtureConversation => ({
  id,
  title,
  startedAt: `2026-10-${at}:00+08:00`,
  updatedAt: `2026-10-${at}:00+08:00`,
});

/** The default conversation section: the first group has more than it shows. */
export const GROUPS_FIXTURE: FixtureGroup[] = [
  {
    agentId: "agt_research",
    agentName: "研究助手",
    conversations: [
      conv("cnv_r1", "整理 Q3 竞品调研要点", "24T16:20"),
      conv("cnv_r2", "检索近三年的行业报告", "24T11:05"),
      conv("cnv_r3", "对比三家云厂商的定价", "23T18:42"),
      conv("cnv_r4", "Acme 年报摘要", "22T09:30"),
      conv("cnv_r5", "用户访谈记录归类", "21T15:12"),
    ],
    more: true,
  },
  {
    agentId: "agt_support",
    agentName: "客服分流",
    conversations: [conv("cnv_s1", "退款工单自动分类规则", "24T10:18")],
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
  newConversationIn: "在此 agent 下新建会话",
  more: "更多",
  moreGroups: "更多分组",
  empty: "还没有会话，从 Agents 里选一个开始。",
  error: "会话列表加载失败",
  retry: "重试",
  expand: "展开侧栏",
  collapse: "收起侧栏",
  menu: "打开导航",
  account: `${FIXTURE_USER.name} · ${FIXTURE_ORG}`,
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
  description: "把 MCP、OpenAPI 等外部服务接进来，agent 就能调用它们的工具。",
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
    owner: "负责人",
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
  breadcrumb: { label: string; href?: string }[];
  title: string;
  sections: { title: string; description: string; fields: FixtureFormField[] }[];
  actionRow: { unsaved: string; errors: string; discard: string; save: string; clean: string };
  status: { context: string; pageStatus: string };
} = {
  breadcrumb: [{ label: "Agents", href: "/agents" }, { label: "研究助手" }],
  title: "编辑 Agent",
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
          error: "组织里已经有一个叫「研究助手」的 agent。",
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
            { name: "sandbox_bash", description: "在沙箱里运行命令", policy: "自动", on: true },
            { name: "acme_docs__search", description: "检索产品文档", policy: "自动", on: true },
            { name: "tickets__update", description: "更新工单状态", policy: "需要审批", on: true },
            {
              name: "ledger__post_entry",
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
  breadcrumbTitle: "编辑 Agent",
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
    { variant: "primary", label: "新建 Agent" },
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

export * from "./conversation";
