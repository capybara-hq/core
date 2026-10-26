/**
 * 目录页假数据：逐字取自已确认的画布稿（e-list / e-detail / e-form / e-table / e-overlays /
 * e-components / e-shell）。这些是目录页夹具而非产品文案，因此不走 next-intl。
 */
import type { CommandGroup, MenuItem, MetricProps, Span, TopBarProps } from "@capybara-hq/design";
import { FIXTURE_ORG, FIXTURE_USER } from "@capybara-hq/design/fixtures";

const noop = () => {};

// ── App Shell（e-shell / e-list 顶栏与状态栏）──────────────────────────────

export const NAV_ITEMS = [
  { id: "overview", label: "概览", href: "/dev/ui/templates/overview" },
  { id: "agents", label: "Agents", href: "/dev/ui/templates/list" },
  { id: "runs", label: "运行记录", href: "/dev/ui/templates/trace" },
  { id: "approvals", label: "审批", href: "/dev/ui/templates/inbox" },
  { id: "kb", label: "知识库", href: "/dev/ui/templates/list" },
  { id: "plugins", label: "插件", href: "/dev/ui/templates/onboarding" },
  { id: "settings", label: "设置", href: "/dev/ui/templates/settings" },
];

export const COMMANDS: CommandGroup[] = [
  {
    label: "跳转",
    items: [
      { id: "goto-support-triage", label: "Agent / support-triage", shortcut: "↵", onSelect: noop },
      { id: "goto-failed-run", label: "运行 / support-triage 最近失败", onSelect: noop },
    ],
  },
  {
    label: "操作",
    items: [
      { id: "try-support-triage", label: "试运行 support-triage", shortcut: "⌘↵", onSelect: noop },
    ],
  },
];

export function topBar(activeNav: string): TopBarProps {
  return {
    nav: NAV_ITEMS,
    activeNav,
    org: {
      name: `${FIXTURE_ORG} / 生产环境`,
      menu: [
        { label: "生产环境", onSelect: noop },
        { label: "预发环境", onSelect: noop },
      ],
    },
    user: {
      name: FIXTURE_USER.name,
      menu: [
        { label: "个人设置", onSelect: noop },
        { label: "退出登录", onSelect: noop },
      ],
    },
    commands: COMMANDS,
  };
}

export function shellStatus(route: string) {
  return {
    context: `${FIXTURE_USER.name}@${FIXTURE_ORG}:${route}`,
    version: "v0.1.0 · UTC+8",
    system: "● 所有系统正常",
  };
}

// ── 列表页（e-list）──────────────────────────────────────────────────────

export const LIST_KPIS: MetricProps[] = [
  { label: "已发布", value: "18" },
  { label: "24H 运行", value: "1,284" },
  { label: "平均成功率", value: "97.2%" },
  { label: "本月成本", value: "¥8,412" },
];

export type Facet = { name: string; items: { label: string; count: number; on: boolean }[] };

export const LIST_FACETS: Facet[] = [
  {
    name: "状态",
    items: [
      { label: "已发布", count: 18, on: true },
      { label: "草稿", count: 4, on: false },
      { label: "已停用", count: 2, on: false },
    ],
  },
  {
    name: "模型",
    items: [
      { label: "claude-opus-5-5", count: 9, on: false },
      { label: "claude-sonnet-5-5", count: 11, on: false },
      { label: "claude-haiku-5-5", count: 4, on: false },
    ],
  },
  {
    name: "触发方式",
    items: [
      { label: "webhook", count: 10, on: false },
      { label: "定时", count: 6, on: false },
      { label: "手动", count: 5, on: false },
      { label: "API", count: 3, on: false },
    ],
  },
  {
    name: "负责人",
    items: [
      { label: "张琳", count: 7, on: false },
      { label: "grant", count: 6, on: false },
      { label: "王浩", count: 5, on: false },
    ],
  },
];

export type AgentRow = {
  name: string;
  ver: string;
  model: string;
  runs: string;
  rate: string;
  owner: string;
  updated: string;
  /** 24 小时运行的 12 段迷你趋势。 */
  spark: number[];
};

/** 确定性的 12 段迷你趋势（每个 Agent 不同）。 */
function sparkOf(seed: number): number[] {
  return Array.from({ length: 12 }, (_, i) => 1 + ((seed * 7 + i * 5 + ((i * i + seed) % 3)) % 6));
}

const agent = (
  name: string,
  ver: string,
  model: string,
  runs: string,
  rate: string,
  owner: string,
  updated: string,
): AgentRow => ({
  name,
  ver,
  model,
  runs,
  rate,
  owner,
  updated,
  spark: sparkOf(name.length + Number(runs)),
});

export const AGENTS: AgentRow[] = [
  agent("support-triage", "v12", "claude-opus-5-5", "412", "98.1%", "张琳", "2 小时前"),
  agent("contract-review", "v7", "claude-opus-5-5", "86", "95.3%", "王浩", "5 小时前"),
  agent("sales-briefing", "v21", "claude-sonnet-5-5", "230", "99.6%", "grant", "昨天"),
  agent("kb-ingest", "v4", "claude-haiku-5-5", "64", "87.5%", "grant", "昨天"),
  agent("invoice-match", "v9", "claude-sonnet-5-5", "158", "97.4%", "张琳", "2 天前"),
  agent("hr-onboarding", "v3", "claude-sonnet-5-5", "22", "100%", "王浩", "3 天前"),
  agent("churn-alert", "v15", "claude-haiku-5-5", "96", "99.0%", "grant", "4 天前"),
  agent("code-review", "v11", "claude-opus-5-5", "131", "96.9%", "张琳", "5 天前"),
  agent("meeting-notes", "v6", "claude-sonnet-5-5", "48", "100%", "王浩", "1 周前"),
  agent("security-triage", "v2", "claude-opus-5-5", "17", "94.1%", "grant", "1 周前"),
  agent("translate-docs", "v8", "claude-haiku-5-5", "40", "100%", "张琳", "2 周前"),
  agent("pricing-sim", "v5", "claude-sonnet-5-5", "30", "96.7%", "王浩", "3 周前"),
];

/** 成功率着色：< 90 fail，< 96 warn，其余 ink（e-list）。 */
export function rateTone(rate: string): "fail" | "warn" | "ink" {
  const r = Number.parseFloat(rate);
  return r < 90 ? "fail" : r < 96 ? "warn" : "ink";
}

export const AGENT_MENU: MenuItem[] = [
  { label: "打开", shortcut: "↵", onSelect: noop },
  { label: "试运行", onSelect: noop },
  { label: "复制名称", shortcut: "⌘C", onSelect: noop },
  { label: "停用", danger: true, onSelect: noop },
];

// ── 详情页（e-detail）────────────────────────────────────────────────────

export const DETAIL_TABS = [
  { id: "summary", label: "概要" },
  { id: "runs", label: "运行", count: "412" },
  { id: "config", label: "配置" },
  { id: "versions", label: "版本", count: "12" },
  { id: "permissions", label: "权限" },
  { id: "audit", label: "审计" },
];

export const DETAIL_KPIS: MetricProps[] = [
  { label: "24H 运行", value: "412" },
  { label: "成功率", value: "98.1%" },
  { label: "P50", value: "6.9s" },
  { label: "本月成本", value: "¥1,420" },
];

const OK_SERIES = [
  8, 6, 4, 3, 3, 4, 9, 18, 26, 30, 28, 24, 27, 29, 31, 26, 22, 19, 16, 14, 12, 10, 9, 7,
];
const FAIL_SERIES = [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];

export const RUN_TREND = OK_SERIES.map((value, i) => ({ value, fail: FAIL_SERIES[i] ?? 0 }));

export const TREND_AXIS = ["00:00", "06:00", "12:00", "18:00", "现在"];

export type RunStatus = "running" | "success" | "failed" | "waiting" | "cancelled";

export type RecentRun = {
  at: string;
  id: string;
  status: RunStatus;
  trigger: string;
  duration: string;
  tokens: string;
};

export const RECENT_RUNS: RecentRun[] = [
  {
    at: "14:02:11",
    id: "run_8f2k1x",
    status: "running",
    trigger: "webhook",
    duration: "—",
    tokens: "12,408",
  },
  {
    at: "13:57:02",
    id: "run_8f2jv3",
    status: "success",
    trigger: "webhook",
    duration: "6.8s",
    tokens: "9,214",
  },
  {
    at: "13:40:55",
    id: "run_8f2jh8",
    status: "success",
    trigger: "webhook",
    duration: "7.4s",
    tokens: "10,082",
  },
  {
    at: "13:12:30",
    id: "run_8f2j5a",
    status: "waiting",
    trigger: "webhook",
    duration: "41.0s",
    tokens: "14,210",
  },
  {
    at: "12:58:02",
    id: "run_8f2hx4",
    status: "failed",
    trigger: "API",
    duration: "9.2s",
    tokens: "6,031",
  },
  {
    at: "12:44:21",
    id: "run_8f2hp8",
    status: "success",
    trigger: "webhook",
    duration: "7.0s",
    tokens: "9,876",
  },
];

export const DETAIL_PROPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "属性",
    rows: [
      ["ID", "agt_41acf09e"],
      ["模型", "claude-opus-5-5"],
      ["温度", "0.3"],
      ["并发", "4"],
    ],
  },
  {
    title: "工具",
    rows: [
      ["读", "kb.search · crm.get_order"],
      ["写", "ticket.reply（需审批 > ¥500）"],
    ],
  },
  {
    title: "触发",
    rows: [
      ["webhook", "/hooks/support"],
      ["密钥", "whsec_••••3f2a"],
    ],
  },
  {
    title: "归属",
    rows: [
      ["负责人", "张琳"],
      ["创建", "2026-08-02 grant"],
      ["环境", "生产环境"],
    ],
  },
];

export const DETAIL_TAGS = ["客服", "退款", "P1"];

// ── 表单页（e-form）──────────────────────────────────────────────────────

export const FORM_ANCHORS = [
  { id: "basic", label: "基本信息", error: true },
  { id: "model", label: "模型与提示词" },
  { id: "tools", label: "工具" },
  { id: "trigger", label: "触发与治理" },
];

export const FORM_PROMPT = [
  "You are an ingestion agent for the company knowledge base.",
  "Split each document into sections of at most 800 tokens.",
  "Keep headings as metadata. Never rewrite the source text.",
  "If a document is not in UTF-8, report it and skip.",
].join("\n");

export const FORM_MODELS = [
  { value: "claude-opus-5-5", label: "claude-opus-5-5" },
  { value: "claude-sonnet-5-5", label: "claude-sonnet-5-5" },
  { value: "claude-haiku-5-5", label: "claude-haiku-5-5" },
];

export const FORM_TOOLS: {
  name: string;
  description: string;
  on: boolean;
  disabled: boolean;
  tag?: string;
}[] = [
  { name: "kb.read", description: "读取知识库文档", on: true, disabled: false },
  { name: "kb.write", description: "写入向量索引", on: true, disabled: false, tag: "写操作" },
  { name: "web.fetch", description: "抓取公开网页", on: false, disabled: false },
  {
    name: "crm.export",
    description: "导出客户数据（组织策略禁用）",
    on: false,
    disabled: true,
    tag: "已禁用",
  },
];

export const FORM_TRIGGERS = [
  { value: "cron", label: "定时", description: "0 */6 * * *" },
  { value: "webhook", label: "Webhook", description: "外部系统推送" },
  { value: "manual", label: "手动", description: "仅控制台触发" },
];

// ── 表格（e-table）───────────────────────────────────────────────────────

export type TableRun = {
  note: string;
  at: string;
  id: string;
  agent: string;
  status: RunStatus;
  duration: string;
  tokens: string;
};

export const TABLE_RUNS: TableRun[] = [
  {
    note: "默认",
    at: "14:02:11",
    id: "run_8f2k1x",
    agent: "support-triage",
    status: "running",
    duration: "18.0s",
    tokens: "12,408",
  },
  {
    note: "悬停",
    at: "13:58:40",
    id: "run_8f2jw9",
    agent: "contract-review",
    status: "waiting",
    duration: "41.2s",
    tokens: "38,120",
  },
  {
    note: "选中（详情打开）",
    at: "13:57:02",
    id: "run_8f2jv3",
    agent: "support-triage",
    status: "success",
    duration: "6.8s",
    tokens: "9,214",
  },
  {
    note: "勾选",
    at: "13:51:26",
    id: "run_8f2jq7",
    agent: "sales-briefing",
    status: "success",
    duration: "12.1s",
    tokens: "21,733",
  },
  {
    note: "勾选",
    at: "13:44:19",
    id: "run_8f2jm0",
    agent: "kb-ingest",
    status: "failed",
    duration: "2.3s",
    tokens: "1,026",
  },
  {
    note: "勾选 + 菜单打开",
    at: "13:40:55",
    id: "run_8f2jh8",
    agent: "support-triage",
    status: "success",
    duration: "7.4s",
    tokens: "10,082",
  },
  {
    note: "键盘焦点",
    at: "13:32:07",
    id: "run_8f2jd2",
    agent: "sales-briefing",
    status: "success",
    duration: "14.9s",
    tokens: "24,510",
  },
  {
    note: "展开",
    at: "13:20:48",
    id: "run_8f2j9p",
    agent: "contract-review",
    status: "waiting",
    duration: "38.6s",
    tokens: "35,977",
  },
  {
    note: "禁用 / 归档",
    at: "13:12:30",
    id: "run_8f2j5a",
    agent: "legacy-bot",
    status: "cancelled",
    duration: "—",
    tokens: "—",
  },
];

export const TABLE_SELECTED_KEY = "run_8f2jv3";
export const TABLE_CHECKED = ["run_8f2jq7", "run_8f2jm0", "run_8f2jh8"];
export const TABLE_EXPANDED_KEY = "run_8f2j9p";
export const TABLE_DISABLED_KEY = "run_8f2j5a";

/** 展开行与调试台的执行链路（e-table 展开行）。 */
export const TRACE_LINES: {
  at: string;
  status: "success" | "waiting";
  kind: string;
  text: string;
  ms?: string;
}[] = [
  {
    at: "14:02:11.8",
    status: "success",
    kind: "plan",
    text: "分类 → 检索政策 → 起草回复",
    ms: "676ms",
  },
  { at: "14:02:12.4", status: "success", kind: "tool", text: 'kb.search("退款政策")', ms: "312ms" },
  { at: "14:02:15.1", status: "waiting", kind: "guard", text: "金额 > ¥500，需人工确认" },
];

export const RUN_MENU: MenuItem[] = [
  { label: "查看详情", shortcut: "↵", onSelect: noop },
  { label: "复制 RUN ID", shortcut: "⌘C", onSelect: noop },
  { label: "重新运行", shortcut: "R", onSelect: noop },
  { label: "终止运行", danger: true, onSelect: noop },
];

export const RUNS_TOTAL = 1284;

// ── 浮层（e-overlays）────────────────────────────────────────────────────

export const RERUN_IDS = "run_8f2jq7 · run_8f2jm0 · run_8f2jh8";

export const STATUS_FILTERS: {
  status: RunStatus | "queued";
  label: string;
  count: number;
  on: boolean;
}[] = [
  { status: "running", label: "运行中", count: 3, on: true },
  { status: "success", label: "成功", count: 1188, on: false },
  { status: "failed", label: "失败", count: 41, on: true },
  { status: "waiting", label: "待审批", count: 7, on: false },
  { status: "cancelled", label: "已取消", count: 45, on: false },
];

export const SHEET_PROPS: [string, string][] = [
  ["模型", "claude-opus-5-5"],
  ["工具", "kb.search · crm.get_order · ticket.reply"],
  ["触发", "webhook · /hooks/support"],
  ["24h", "412 次 · 成功率 98.1%"],
  ["负责人", "张琳"],
];

// ── 组件（e-components）──────────────────────────────────────────────────

export const BUTTON_VARIANTS = [
  { variant: "primary", name: "Primary", use: "实心主色", label: "新建 Agent" },
  { variant: "secondary", name: "Secondary", use: "主色描边", label: "部署" },
  { variant: "default", name: "Default", use: "中性描边", label: "导出" },
  { variant: "ghost", name: "Ghost", use: "无边框", label: "取消" },
  { variant: "danger", name: "Danger", use: "危险描边", label: "删除" },
] as const;

export const SEGMENTS = [
  { value: "1h", label: "1H" },
  { value: "24h", label: "24H" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
];

/** Span 瀑布的假数据（spec §6.10）：成功 / 失败 / 进行中、审批等待、未结束延伸到末端。 */
export const TRACE_SPANS: Span[] = [
  { id: "run", kind: "run", label: "run · v12", startMs: 0, durationMs: null, status: "pending" },
  {
    id: "s0",
    parentId: "run",
    kind: "step",
    label: "step 0",
    startMs: 200,
    durationMs: 5200,
    status: "ok",
  },
  {
    id: "m0",
    parentId: "s0",
    kind: "model",
    label: "anthropic/claude-opus-5-5",
    startMs: 200,
    durationMs: 900,
    status: "error",
  },
  {
    id: "m1",
    parentId: "s0",
    kind: "model",
    label: "model-fake/fake-1",
    startMs: 1100,
    durationMs: 1800,
    status: "ok",
    meta: "↑9,214 ↓312",
  },
  {
    id: "t0",
    parentId: "s0",
    kind: "tool",
    label: "kb__search",
    startMs: 2900,
    durationMs: 312,
    status: "ok",
  },
  {
    id: "t1",
    parentId: "s0",
    kind: "tool",
    label: "crm__refund_order",
    startMs: 3300,
    durationMs: 2100,
    status: "ok",
  },
  {
    id: "w1",
    parentId: "t1",
    kind: "wait",
    label: "approval",
    startMs: 3300,
    durationMs: 1800,
    status: "ok",
  },
  {
    id: "s1",
    parentId: "run",
    kind: "step",
    label: "step 1",
    startMs: 5500,
    durationMs: null,
    status: "pending",
  },
  {
    id: "m2",
    parentId: "s1",
    kind: "model",
    label: "model-fake/fake-1",
    startMs: 5500,
    durationMs: null,
    status: "pending",
  },
  {
    id: "t2",
    parentId: "s1",
    kind: "tool",
    label: "ticket__reply",
    startMs: 6400,
    durationMs: null,
    status: "pending",
  },
  {
    id: "w2",
    parentId: "t2",
    kind: "wait",
    label: "approval",
    startMs: 6400,
    durationMs: null,
    status: "pending",
  },
];
