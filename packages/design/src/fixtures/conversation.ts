/**
 * Conversation-page fixtures (UI refresh B): the fixed sample data of the B reference blocks
 * (docs/design/reference/src) and, later, the `/dev/ui` conversation blocks. Pure data, no React.
 * Structure and counts follow the canvas conversation boards (tool calls, human in the loop,
 * sub-agents, files, right panel); every name is a placeholder (示例组织, 研究助手, Acme…).
 */

import type { PresetId } from "../display/avatar-presets";

// ── Page, agent, models ─────────────────────────────────────────────────────

export type FixtureModelOption = { id: string; label: string; efforts?: string[] };
export type FixtureModelGroup = { provider: string; label: string; models: FixtureModelOption[] };

/**
 * A long model list (§6.16.3 state `long`): two providers of fifty models each, the checked one
 * deep in the second group, so the menu is capped, filtered and scrolled to the checked model.
 */
export const LONG_MODELS_FIXTURE: {
  groups: { provider: string; label: string; models: { id: string; label: string }[] }[];
  /** The checked model's id. */
  selected: string;
  /** What the filter field holds in the reference block (empty: the whole list). */
  query: string;
} = {
  groups: [
    { provider: "acme", label: "Acme Cloud" },
    { provider: "north", label: "North AI" },
  ].map((g, gi) => ({
    ...g,
    models: Array.from({ length: 50 }, (_, i) => {
      const n = gi * 50 + i + 1;
      return { id: `model-${n}`, label: `${g.provider}-chat-${String(n).padStart(3, "0")}` };
    }),
  })),
  selected: "model-80",
  query: "",
};

export const CONV_FIXTURE: {
  title: string;
  /** A 60-character CJK title for the long-title block. */
  longTitle: string;
  /** Start time of an untitled conversation (`未命名会话 · MM-DD HH:mm`). */
  untitledAt: string;
  agent: { id: string; name: string };
  /** The agent dropdown of a new conversation. */
  agents: { id: string; name: string }[];
  /** Chat models of the org's providers, the agent's own model first (spec §5.2). */
  models: FixtureModelGroup[];
  effortLabels: Record<string, string>;
  selected: { provider: string; model: string; effort: string };
  /** The model with no declared effort (the composer hides the effort dropdown). */
  noEffortModel: { provider: string; model: string };
  path: string;
  stats: { turns: number; elapsed: string; context: string; status: string; version: string };
  user: { text: string; second: string };
} = {
  title: "分析 9 月示例表差异",
  longTitle:
    "请根据上一季度各事业部提交的经营数据汇总表逐项核对收入成本费用并给出差异原因分析和改进建议清单以及后续跟踪计划",
  untitledAt: "2026-10-26T14:32:00+08:00",
  agent: { id: "agt_research", name: "研究助手" },
  agents: [
    { id: "agt_research", name: "研究助手" },
    { id: "agt_support", name: "客服分流" },
    { id: "agt_weekly", name: "周报助手" },
  ],
  models: [
    {
      provider: "anthropic",
      label: "Anthropic",
      models: [
        { id: "claude-opus-5-5", label: "opus 5.5", efforts: ["low", "medium", "high", "max"] },
        { id: "claude-sonnet-5", label: "sonnet 5", efforts: ["low", "medium", "high"] },
      ],
    },
    {
      provider: "deepseek",
      label: "DeepSeek",
      models: [{ id: "deepseek-chat", label: "deepseek-chat" }],
    },
  ],
  effortLabels: { low: "低", medium: "中等", high: "高", xhigh: "很高", max: "最高" },
  selected: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
  noEffortModel: { provider: "deepseek", model: "deepseek-chat" },
  path: "grant@示例组织:/chat/9f3a",
  stats: { turns: 14, elapsed: "1 分 03 秒", context: "43%", status: "运行中", version: "v0.1.0" },
  user: {
    text: "帮我核对一下 9 月示例表的差异，列出原因",
    second: "看看文档目录的结构。",
  },
};

/** The composer's environment picker (spec §6.16.2): the choices, one of them not usable. */
export const ENVIRONMENT_FIXTURE = {
  selected: "dev-docker",
  items: [
    { id: "dev-docker", label: "开发沙盒" },
    { id: "prod-cloud", label: "云端沙盒", tag: "未配置", disabled: true },
  ],
} as const;

/** Composer, title bar and panel copy of the reference pages (zh; product copy goes through i18n). */
export const CONV_COPY = {
  placeholder: "输入消息，/ 使用命令",
  newPlaceholder: "想让 研究助手 做什么？",
  runningHint: "运行中发送的消息会在下一步交给智能体",
  attach: "添加附件",
  send: "发送",
  stop: "停止",
  agent: "切换智能体",
  model: "切换模型",
  effort: "思考档位",
  agentLocked: "发送第一条消息后不能再换智能体",
  environment: "切换环境",
  environmentLocked: "发送第一条消息后不能再换环境",
  modelHint: "从下一条消息起生效",
  properties: "属性面板",
  files: "文件",
  more: "更多",
  rename: "重命名",
  copyLink: "复制链接",
  delete: "删除会话",
  close: "关闭",
  back: "返回",
  fullscreen: "全屏",
  download: "下载",
  openInPanel: "在右侧面板打开",
  collapse: "收起",
  retry: "重试",
  failedToLoad: "加载失败",
  copyOutput: "复制输出",
  viewAll: "查看全文",
  open: "打开",
} as const;

// ── Tool calls ──────────────────────────────────────────────────────────────

export type FixtureDiffLine = {
  kind: "ctx" | "add" | "del";
  old?: number;
  new?: number;
  text: string;
};

export type FixtureTool = {
  id: string;
  kind: "command" | "read" | "edit" | "search" | "connector" | "meta" | "question" | "tool";
  /**
   * The bold name: a builtin's tool name ("Bash", "Read"), or the connector's / plugin's display
   * name of a connector or extension tool.
   */
  name: string;
  /** A connector or extension tool's local name, shown in brackets. */
  tool?: string;
  /** The tool's declared title (the row's tooltip). */
  tooltip?: string;
  /** A shell command's `description`. */
  description?: string;
  /** Key arguments, shown in body color. */
  keyArg?: string;
  /** Extra info after the key arguments (faint). */
  extra?: string;
  status: "running" | "done" | "failed";
  /** A running call that waits for a person (§6.16.9): no spinner, no timer. */
  waiting?: "approval" | "input" | "connect";
  elapsed?: string;
  durationMs?: number;
  input?: [string, string][];
  command?: string;
  output?: string;
  outputBytes?: number;
  error?: string;
  diff?: FixtureDiffLine[];
  added?: number;
  removed?: number;
};

const cmd = (
  id: string,
  description: string,
  status: FixtureTool["status"] = "done",
): FixtureTool => ({
  id,
  kind: "command",
  name: "Bash",
  description,
  status,
  ...(status === "failed" ? { error: "退出码 1" } : {}),
});

export const TOOL_FIXTURES: Record<
  | "single"
  | "running"
  | "done"
  | "doneFailed"
  | "oneObject"
  | "expanded"
  | "diff"
  | "largeOutput"
  | "hookDenied"
  | "waiting",
  FixtureTool[]
> = {
  // Two separate single calls (each one line, no box).
  single: [
    {
      id: "t_single_search",
      kind: "connector",
      name: "Acme 工单",
      tool: "search_tickets",
      tooltip: "搜索工单",
      keyArg: "#反馈 本周",
      extra: "42 条",
      status: "done",
    },
    {
      id: "t_single_read",
      kind: "read",
      name: "Read",
      keyArg: "reports/2026-09/示例表.xlsx",
      extra: "第 1–120 行",
      status: "done",
    },
  ],
  running: [
    cmd("t_run_1", "导出流程节点并搜索映射逻辑"),
    cmd("t_run_2", "检查计算节点配置"),
    { ...cmd("t_run_3", "按编号拉取计算代码", "running"), elapsed: "12 秒" },
  ],
  // 6 commands and 2 tools, none failed.
  done: [
    cmd("t_done_1", "读取示例表并定位差异行"),
    cmd("t_done_2", "按收款人汇总金额"),
    cmd("t_done_3", "导出差异明细"),
    cmd("t_done_4", "核对总账余额"),
    cmd("t_done_5", "生成对账报告"),
    cmd("t_done_6", "压缩输出文件"),
    {
      id: "t_done_7",
      kind: "connector",
      name: "Acme 文档",
      tool: "get_file_metadata",
      tooltip: "获取文件元数据",
      status: "done",
    },
    {
      id: "t_done_8",
      kind: "connector",
      name: "Acme 文档",
      tool: "get_file_permissions",
      tooltip: "获取文件权限",
      status: "done",
    },
  ],
  // The same counts with one failed command.
  doneFailed: [
    cmd("t_fail_1", "读取示例表并定位差异行"),
    cmd("t_fail_2", "按收款人汇总金额"),
    cmd("t_fail_3", "导出差异明细", "failed"),
    cmd("t_fail_4", "核对总账余额"),
    cmd("t_fail_5", "生成对账报告"),
    cmd("t_fail_6", "压缩输出文件"),
    {
      id: "t_fail_7",
      kind: "connector",
      name: "Acme 文档",
      tool: "get_file_metadata",
      tooltip: "获取文件元数据",
      status: "done",
    },
    {
      id: "t_fail_8",
      kind: "connector",
      name: "Acme 文档",
      tool: "get_file_permissions",
      tooltip: "获取文件权限",
      status: "done",
    },
  ],
  // One command and one read of a single file: the header names the file.
  oneObject: [
    cmd("t_one_1", "检查文件编码"),
    {
      id: "t_one_2",
      kind: "read",
      name: "Read",
      keyArg: "示例流程交付说明.pdf",
      status: "done",
    },
  ],
  // Meta, connector (expanded), connector, connector failed, command (expanded).
  expanded: [
    {
      id: "t_exp_meta",
      kind: "meta",
      name: "ToolSearch",
      extra: "Acme 文档 6 个",
      status: "done",
    },
    {
      id: "t_exp_conn",
      kind: "connector",
      name: "Acme 文档",
      tool: "get_file_metadata",
      tooltip: "获取文件元数据",
      keyArg: "示例流程交付说明.pdf",
      status: "done",
      durationMs: 800,
      input: [
        ["fileId", "1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT-xyZ"],
        ["excludeContentSnippets", "true"],
      ],
      output:
        '{ "fileExtension": "pdf", "fileSize": "3836086", "mimeType": "application/pdf",\n  "modifiedTime": "2026-10-22T10:08:39Z", "title": "示例流程交付说明.pdf",\n  "viewUrl": "https://docs.acme.example/file/1aB2cD3…/view" }',
    },
    {
      id: "t_exp_perm",
      kind: "connector",
      name: "Acme 文档",
      tool: "get_file_permissions",
      tooltip: "获取文件权限",
      status: "done",
    },
    {
      id: "t_exp_failed",
      kind: "connector",
      name: "Acme 文档",
      tool: "get_file_metadata",
      tooltip: "获取文件元数据",
      status: "failed",
      durationMs: 400,
      input: [["fileId", "9zY8xW7vU6tS5rQ4pO3nM2lK1jI0hG-abC"]],
      error: "404 文件不存在",
      output:
        'Error 404: file not found\n{ "error": { "code": 404, "message": "File not found: 9zY8xW7vU6tS5rQ4pO3nM2lK1jI0hG-abC" } }',
    },
    {
      id: "t_exp_cmd",
      kind: "command",
      name: "Bash",
      description: "更新草稿里的 PDF 链接",
      status: "done",
      durationMs: 2100,
      command: "python scripts/update_draft.py --channel 示例-支持 --pdf 示例流程交付说明.pdf",
      output:
        "draft 1792665 updated\nlink: https://docs.acme.example/file/1aB2cD3…/view\n[exit code: 0]",
    },
  ],
  // Three edited files; the first carries its diff.
  diff: [
    {
      id: "t_diff_1",
      kind: "edit",
      name: "Edit",
      keyArg: "scripts/calc.py",
      status: "done",
      added: 2,
      removed: 1,
      diff: [
        {
          kind: "ctx",
          old: 258,
          new: 258,
          text: '    c_name, c_acct = col_like("收款人名称"), col_like("费用科目")',
        },
        { kind: "del", old: 259, text: "    if nm and cat:" },
        { kind: "add", new: 259, text: "    if nm and cat and not is_blank_row(r):" },
        { kind: "add", new: 260, text: "        # 同收款人 + 同科目只留第一行" },
        {
          kind: "ctx",
          old: 260,
          new: 261,
          text: '        entries.append({"name": nm, "acct": acct})',
        },
      ],
    },
    {
      id: "t_diff_2",
      kind: "edit",
      name: "Edit",
      keyArg: "scripts/report.py",
      status: "done",
      added: 40,
      removed: 9,
    },
    {
      id: "t_diff_3",
      kind: "edit",
      name: "Edit",
      keyArg: "reports/对账报告.md",
      status: "done",
      added: 6,
      removed: 2,
    },
  ],
  largeOutput: [
    {
      id: "t_large",
      kind: "command",
      name: "Bash",
      keyArg: 'grep -rn "示例表" scripts/',
      status: "done",
      command: 'grep -rn "示例表" scripts/',
      outputBytes: 82 * 1024,
      output:
        'scripts/calc.py:88:    rp = load_sheet("示例表")\nscripts/calc.py:91:    rp_names = {norm_name(r[0]) for r in rp}\nscripts/calc.py:402:   if payee in rp_names or row["Related?"] == "Y":\nscripts/report.py:17:  src = open_book("示例表.xlsx")\n…',
    },
  ],
  hookDenied: [
    {
      id: "t_hook",
      kind: "connector",
      name: "Acme 工单",
      tool: "send_message",
      tooltip: "发送消息",
      keyArg: "#示例-支持",
      status: "failed",
      error: "被扩展「合规审查」拒绝",
      input: [
        ["channel", "#示例-支持"],
        ["text", "15 条流程已逐条核对完，可以交给你试运行……"],
      ],
      output: "合规审查: 外部频道的消息需要先经过审核（policy hook tool.preExecute）",
    },
  ],
  // An AskUserQuestion call waiting for the person's answer: "已提问 <header>", no timer.
  waiting: [
    {
      id: "t_wait_question",
      kind: "question",
      name: "AskUserQuestion",
      keyArg: "对账口径",
      status: "running",
      waiting: "input",
    },
  ],
};

// ── Prose, thinking ─────────────────────────────────────────────────────────

export const PROSE_FIXTURE: {
  markdown: string;
  streaming: string;
  thinking: string;
  thinkingSeconds: number;
  /** Prose that mentions file paths: chips only for paths naming a file output. */
  withPaths: string;
} = {
  markdown: [
    "差异主要来自两笔**内部换汇**，都发生在 9 月 18 日，示例表只记了换出的一腿：",
    "",
    "| 币种 | 差额 | 原因 |",
    "| --- | ---: | --- |",
    "| USD | −2,900.00 | 只记了换出一腿 |",
    "| HKD | −109.51 | 只记了换出一腿 |",
    "",
    "## 下一步",
    "",
    "1. 在总账补记换入的一腿；",
    "2. 用 `calc.py --month 2026-09` 重跑汇总；",
    "3. 核对后再导出 [对账说明](https://docs.acme.example/recon)。",
  ].join("\n"),
  streaming:
    "差异主要来自两笔内部换汇：HKD 少记 109.51，USD 少记 2,900.00。两笔都发生在 9 月 18 日",
  thinking: "两种说法都可能对。先看代码里遇到重复收款人时怎么取，再去映射表核对实际行……",
  thinkingSeconds: 12,
  withPaths:
    "我改的是 `scripts/calc.py` 第 259 行，结果写在 reports/9月差异明细.xlsx，说明在 reports/对账报告.md。",
};

// ── Human in the loop ───────────────────────────────────────────────────────

export const HITL_FIXTURE: {
  approval: {
    /** "<connector>: <title>" as the head shows it. */
    tool: string;
    /** The model-visible tool key, always shown after the title (design spec §6.16.11). */
    toolKey: string;
    /** Every input property, the tool's keyArgs first. */
    args: [string, string][];
    scopes: ("once" | "session" | "always")[];
    policy: string;
    denyReason: string;
  };
  question: { question: string; options: string[]; selected: number; other: string };
  questionUrl: { question: string; url: string };
  connect: { service: string; reason: string; note: string };
  decided: {
    who: string;
    approved: { tool: string; toolKey: string; at: string; scope: string };
    denied: { tool: string; toolKey: string; at: string; reason: string };
    answered: { answer: string };
    connected: { service: string; at: string };
  };
} = {
  approval: {
    tool: "Acme 工单: 发送消息",
    toolKey: "mcp__acme_tickets__send_message",
    args: [
      ["channel", "#示例-支持"],
      ["text", "15 条流程已逐条核对完，可以交给你试运行……"],
      ["notify_all", "true"],
      ["attachments", '[{"name":"流程核对.xlsx","bytes":48213}]'],
    ],
    scopes: ["once", "session", "always"],
    policy: "策略：发消息需审批",
    denyReason: "先别发，等财务确认",
  },
  question: {
    question: "示例表里同一收款人有两行映射，流程应该保留哪一个类别？",
    options: ["服务费（按费用科目）", "办公租金（按字面理解）"],
    selected: 0,
    other: "写下你的答案",
  },
  questionUrl: {
    question: "Acme 门户需要你在浏览器里确认授权",
    url: "https://portal.acme.example/oauth/consent?session=7f3a2c",
  },
  connect: {
    service: "Acme 文档",
    reason: "连接 Acme 文档 后才能读取这个文件",
    note: "用你自己的账号授权，只对你生效",
  },
  decided: {
    who: "grant",
    approved: {
      tool: "Acme 工单: 发送消息",
      toolKey: "mcp__acme_tickets__send_message",
      at: "10:32",
      scope: "仅这一次",
    },
    denied: {
      tool: "Acme 表格: 写入单元格",
      toolKey: "mcp__acme_sheets__write_cells",
      at: "10:35",
      reason: "先别写，等财务确认",
    },
    answered: { answer: "服务费（按费用科目）" },
    connected: { service: "Acme 文档", at: "10:36" },
  },
};

/** Two queued messages (shown translucent, dashed, below the sent bubble). */
export const QUEUE_FIXTURE: { text: string }[] = [
  { text: "顺便把 PDF 也重新生成一下" },
  { text: "再按收款人汇总一张表" },
];

export type FixturePaletteItem = {
  id: string;
  label: string;
  hint?: string;
  tags?: string[];
  description?: string;
  search?: string;
  source?: string;
};

/**
 * Phase D: the skill chip in the composer and the `/` palette (design spec §6.16.2 state `skill`,
 * §6.7 `command-palette`). Skills are sorted by name; `filtered` is the palette with `query`.
 */
export const SKILL_FIXTURE: {
  chip: { label: string; hint: string };
  /** A sent invocation (user bubble, state `skill`): its arguments and the disclosure's title. */
  bubble: { arguments: string; details: string };
  groups: { label: string; items: FixturePaletteItem[] }[];
  query: string;
} = {
  chip: { label: "/fix-issue", hint: "[issue-number]" },
  bubble: { arguments: "123", details: "技能说明" },
  groups: [
    {
      label: "技能",
      items: [
        {
          id: "skill:brainstorming",
          label: "/brainstorming",
          search: "superpowers:brainstorming",
          source: "superpowers",
          description: "动手之前先梳理需求和方案",
        },
        {
          id: "skill:fix-issue",
          label: "/fix-issue",
          hint: "[issue-number]",
          description: "按团队规范修复一个 GitHub issue",
        },
        {
          id: "skill:release-check",
          label: "/release-check",
          tags: ["手动"],
          description: "运行发布前的检查脚本",
        },
        {
          id: "skill:review",
          label: "/review",
          hint: "[path]",
          tags: ["子智能体"],
          search: "dev-kit:review",
          source: "dev-kit",
          description: "在子智能体里审查代码改动",
        },
      ],
    },
    {
      label: "GitHub",
      items: [
        {
          id: "prompt:github:review-pr",
          label: "/github:review-pr",
          search: "review-pr",
          description: "审查一个 PR 并给出意见",
        },
      ],
    },
  ],
  query: "review",
};

export const DIVIDER_FIXTURE: {
  stopped: { who: string; at: string };
  failed: { reason: string };
  compacted: { saved: string; summary: string };
  fallback: { from: string; to: string };
  hookDenied: { extension: string; reason: string };
} = {
  stopped: { who: "grant", at: "10:41" },
  failed: { reason: "模型 60 秒无响应" },
  compacted: {
    saved: "64%",
    summary:
      "用户要求核对 9 月示例表差异。已定位两笔内部换汇只记一腿，已导出差异明细；待补记总账并重跑汇总。",
  },
  fallback: { from: "sonnet 5", to: "opus 5.5" },
  hookDenied: { extension: "合规审查", reason: "外部频道的消息需要先经过审核" },
};

// ── Sub-agents ──────────────────────────────────────────────────────────────

export type FixtureSubagent = {
  id: string;
  agentType: string;
  description: string;
  status: "running" | "done" | "failed";
  toolCalls: number;
  duration: string;
  /** The dispatch prompt, the call block's IN. */
  prompt: string;
  /** The current tool summary of a running sub-agent. */
  current?: string;
  tokens: number;
};

export const SUBAGENT_FIXTURE: {
  running: FixtureSubagent[];
  done: FixtureSubagent[];
  /** The id of the sub-agent open in the right panel. */
  open: string;
  totals: { calls: number; duration: string };
  panel: {
    task: string;
    meta: string;
    tools: string;
    prose: string;
    current: string;
    footer: string;
    context: string;
  };
} = {
  running: [
    {
      id: "sa_tree",
      agentType: "调研",
      description: "列出示例文档目录树",
      status: "running",
      toolCalls: 20,
      duration: "2分28秒",
      prompt:
        "只读地列出文档文件夹「示例项目」下的完整目录树。不要移动、改名、删除、共享或修改任何文件。输出：写成 JSON 到 docs/tree.json；最终回复给出文件总数、目录深度，以及一、二级目录名称。",
      current: "Bash 列出「02 流程 / 10 现金预算」下的子目录",
      tokens: 48_200,
    },
    {
      id: "sa_dedupe",
      agentType: "调研",
      description: "读流程 v12 的去重代码",
      status: "running",
      toolCalls: 5,
      duration: "48 秒",
      prompt:
        "读流程 v12 里处理重复收款人的代码，说明去重规则：按哪些字段判重、重复时保留哪一行。只读，不要改代码。",
      current: "Read flows/v12/dedupe.py",
      tokens: 21_300,
    },
  ],
  done: [
    {
      id: "sa_map",
      agentType: "调研",
      description: "核对映射表里的重复收款人",
      status: "done",
      toolCalls: 8,
      duration: "1分12秒",
      prompt:
        "核对映射表里收款人重复的行：按收款人和科目分组，说明流程遇到重复时取哪一行，并列出受影响的供应商。只读，不要改表。",
      tokens: 63_400,
    },
    {
      id: "sa_ids",
      agentType: "调研",
      description: "收集流程引用的文档 ID",
      status: "done",
      toolCalls: 9,
      duration: "41 秒",
      prompt: "收集流程 v12 引用的全部文档和文件夹 ID，按引用位置列出。",
      tokens: 30_100,
    },
    {
      id: "sa_draft",
      agentType: "起草",
      description: "给财务的确认消息",
      status: "failed",
      toolCalls: 4,
      duration: "1分07秒",
      prompt: "起草一条给财务的确认消息，说明重复收款人的处理规则，请他们确认。",
      tokens: 12_800,
    },
  ],
  open: "sa_tree",
  totals: { calls: 21, duration: "2分40秒" },
  panel: {
    task: "只读地列出文档文件夹「示例项目」下的完整目录树。不要移动、改名、删除、共享或修改任何文件。输出：写成 JSON 到 docs/tree.json；最终回复给出文件总数、目录深度，以及一、二级目录名称。",
    meta: "研究助手 · 子智能体 · opus 5.5 · 只读工具",
    tools: "Acme 文档 6 个",
    prose: "已展开 6 层，共 214 个文件夹。正在处理「02 流程 / 10 现金预算」下的子目录……",
    current: "parentId = 1sEaKw6E…",
    footer: "子智能体只读 · 不能和它对话",
    context: "31%",
  },
};

// ── Files ───────────────────────────────────────────────────────────────────

export type FixtureFile = {
  id: string;
  name: string;
  type: string;
  size: string;
  version?: number;
  removed?: boolean;
};

export type FixtureAttachment = {
  kind: "image" | "file";
  name: string;
  type: string;
  size: string;
  /** Upload progress in percent while uploading. */
  progress?: number;
  /** Why it was rejected. */
  error?: string;
};

const file = (
  id: string,
  name: string,
  type: string,
  size: string,
  version?: number,
): FixtureFile => ({
  id,
  name,
  type,
  size,
  ...(version === undefined ? {} : { version }),
});

export const FILE_FIXTURE: {
  attachments: FixtureAttachment[];
  outputs: FixtureFile[];
  many: FixtureFile[];
  image: FixtureFile & { dimensions: string };
  text: FixtureFile & { head: string };
  removed: FixtureFile & { reason: string };
  /** Paths mentioned in prose that name file outputs. */
  paths: string[];
  /** The markdown file's rendered preview and the plain-text preview. */
  markdownPreview: string;
  textPreview: string;
  /** The preview panel's sheet tabs and the file switcher's "updated" label. */
  sheets: string[];
  updated: string;
} = {
  attachments: [
    { kind: "image", name: "截图.png", type: "PNG", size: "220 KB" },
    { kind: "file", name: "示例流程交付说明.pdf", type: "PDF", size: "3.8 MB" },
    { kind: "file", name: "9月流水.xlsx", type: "XLSX", size: "1.2 MB", progress: 62 },
    { kind: "file", name: "全年凭证.zip", type: "ZIP", size: "86 MB", error: "超过 50 MB" },
  ],
  outputs: [
    file("fo_detail", "9月差异明细.xlsx", "XLSX", "48 KB", 2),
    file(
      "fo_long",
      "2026年第三季度各事业部经营数据汇总与收入成本费用差异逐项核对明细表及改进建议清单与后续跟踪计划财务部最终确认版本v3.xlsx",
      "XLSX",
      "2.4 MB",
      1,
    ),
  ],
  many: [
    file("fo_report", "对账报告.md", "MD", "6 KB", 1),
    file("fo_rows", "差异行.csv", "CSV", "12 KB", 1),
    file("fo_pdf", "示例流程交付说明.pdf", "PDF", "3.8 MB", 1),
    file("fo_chart", "月度差异趋势.png", "PNG", "84 KB", 1),
    file("fo_summary", "汇总.txt", "TXT", "2 KB", 1),
    file("fo_detail2", "9月差异明细.xlsx", "XLSX", "48 KB", 2),
  ],
  image: { ...file("fo_chart", "月度差异趋势.png", "PNG", "84 KB", 1), dimensions: "1280×720" },
  text: {
    ...file("fo_report", "对账报告.md", "MD", "6 KB", 1),
    head: "# 9 月对账报告\n## 结论\n差异合计 USD 2,900.00、HKD 109.51，均来自 9 月 18 日的两笔内部换汇……\n## 明细\n| 日期 | 收款人 | 差额 |",
  },
  removed: {
    ...file("fo_old", "8月差异明细.xlsx", "XLSX", "51 KB", 1),
    removed: true,
    reason: "文件已不可用",
  },
  paths: ["reports/9月差异明细.xlsx", "reports/对账报告.md"],
  markdownPreview: [
    "# 9 月对账报告",
    "",
    "## 结论",
    "",
    "差异合计 **USD 2,900.00**、**HKD 109.51**，均来自 9 月 18 日的两笔内部换汇。",
    "",
    "## 明细",
    "",
    "- 两笔换汇只记了换出的一腿；",
    "- 映射表里有 4 个收款人存在重复行；",
    "- 其余差异来自跨月和未入账的手续费。",
  ].join("\n"),
  textPreview:
    "9 月对账汇总\n============\n差异行数     14\n涉及收款人   9\n合计 USD     -4,185.00\n合计 HKD     -30,768.80\n合计 JPY     -150,000\n\n生成时间 2026-10-26 10:41",
  sheets: ["差异明细", "按收款人汇总"],
  updated: "刚刚",
};

// ── Properties panel, right panel, extension slots ──────────────────────────

export const PANEL_FIXTURE: {
  context: { ratio: number; model: string; sandbox: string; connectors: string[] };
  tasks: {
    done: number;
    total: number;
    items: { text: string; state: "done" | "current" | "todo" }[];
  };
  background: { running: { name: string; duration: string }[]; completed: number };
  /** The CSV preview: a header row then data rows. */
  csvRows: string[][];
  extensions: {
    todo: { name: string; view: string };
    board: {
      name: string;
      columns: { title: string; cards: { text: string; current?: boolean }[] }[];
    };
    failed: { name: string; reason: string };
  };
  /** The right-panel switcher: what can be open (extension panels, then files). */
  switcher: { label: string; kind: "extension" | "file"; type?: string }[];
} = {
  context: {
    ratio: 43,
    model: "opus 5.5",
    sandbox: "沙箱运行中",
    connectors: ["Acme 文档", "Acme 工单"],
  },
  tasks: {
    done: 2,
    total: 4,
    items: [
      { text: "读取示例表", state: "done" },
      { text: "定位差异行", state: "done" },
      { text: "导出差异明细", state: "current" },
      { text: "写回总账", state: "todo" },
    ],
  },
  background: { running: [{ name: "列出示例文档目录树", duration: "2:28" }], completed: 6 },
  csvRows: [
    ["日期", "收款人", "币种", "差额", "原因"],
    ["09-18", "Acme 内部换汇", "HKD", "−109.51", "只记了换出一腿"],
    ["09-18", "Acme 内部换汇", "USD", "−2,900.00", "只记了换出一腿"],
    ["09-05", "示例供应商 A", "USD", "−1,240.00", "映射表重复行"],
    ["09-07", "示例供应商 B", "HKD", "−8,800.00", "映射表重复行"],
    ["09-11", "示例供应商 C", "JPY", "−150,000", "映射表重复行"],
    ["09-12", "示例供应商 D", "HKD", "−22,000.00", "类别取最后一行"],
    ["09-20", "示例供应商 E", "EUR", "−560.00", "发票号缺失"],
    ["09-24", "示例银行 手续费", "USD", "−12.00", "未入账"],
    ["09-26", "示例银行 利息", "HKD", "+31.20", "未入账"],
    ["09-30", "示例服务 月费", "USD", "−45.00", "跨月"],
  ],
  extensions: {
    todo: { name: "待办", view: "tasks" },
    board: {
      name: "任务看板",
      columns: [
        { title: "待开始 2", cards: [{ text: "13 费用预提" }, { text: "14 关联方对账" }] },
        { title: "进行中 1", cards: [{ text: "10 现金预算 · 本会话", current: true }] },
        { title: "已通过 12", cards: [{ text: "5 余额核对" }, { text: "7 付款申请" }] },
      ],
    },
    failed: { name: "任务看板", reason: "扩展 10 秒内没有响应" },
  },
  switcher: [
    { label: "待办", kind: "extension" },
    { label: "任务看板", kind: "extension" },
    { label: "9月差异明细.xlsx", kind: "file", type: "XLSX" },
    { label: "对账报告.md", kind: "file", type: "MD" },
    { label: "差异行.csv", kind: "file", type: "CSV" },
  ],
};

// ── New conversation: greeting, agents row, quick actions (§6.16.25–§6.16.27) ──

export type FixtureAgent = {
  id: string;
  name: string;
  description: string;
  /** A preset of the avatars (§6.30), or null for the initial. */
  preset: PresetId | null;
};

export const NEW_CONVERSATION_FIXTURE: {
  greeting: string;
  agents: FixtureAgent[];
  selected: string;
  /** Most recent first: the panel's 最近用过 group. */
  recent: string[];
  quickActions: { id: string; title: string }[];
  /** A search that matches nothing (the panel's no-match state). */
  noMatch: string;
} = {
  greeting: "下午好，grant",
  agents: [
    {
      id: "ag1",
      name: "研究助手",
      description: "检索资料、核对数据并整理成报告。",
      preset: "capybara",
    },
    {
      id: "ag2",
      name: "财务对账",
      description: "按月核对总账与银行流水，列出差异。",
      preset: "owl",
    },
    {
      id: "ag3",
      name: "合同审阅",
      description: "审合同条款，标出风险和要改的地方。",
      preset: "elephant",
    },
    { id: "ag4", name: "周报整理", description: "汇总一周的进展，写成周报。", preset: "rabbit" },
    { id: "ag5", name: "客服助手", description: "回答工单里的常见问题。", preset: "panda" },
    { id: "ag6", name: "发布说明", description: "从合并记录写发布说明。", preset: null },
    { id: "ag7", name: "数据看板", description: "查询指标并画成图表。", preset: "whale" },
    { id: "ag8", name: "翻译", description: "中英互译，保留术语。", preset: "fox" },
  ],
  selected: "ag1",
  recent: ["ag2", "ag1", "ag4"],
  quickActions: [
    { id: "q1", title: "核对上月总账与银行流水" },
    { id: "q2", title: "整理本周进展，按项目写成周报并列出下周计划和风险" },
    { id: "q3", title: "查一个供应商的背景" },
    { id: "q4", title: "汇总差异明细" },
    { id: "q5", title: "写一份会议纪要" },
    { id: "q6", title: "翻译一份合同" },
  ],
  noMatch: "报销",
};

/** A long user message (§6.16.6 states `long` / `expanded`): taller than eight prose lines. */
export const LONG_MESSAGE_FIXTURE: { text: string } = {
  text: [
    "请按下面的步骤核对 9 月的示例表：",
    "1. 先读 finance/q3/summary.csv，按事业部汇总收入和成本；",
    "2. 再和总账导出的 ledger-2026-09.xlsx 逐行比对；",
    "3. 差异超过 500 元的行单独列出，写明可能的原因；",
    "4. 每个差异找到对应的凭证号；",
    "5. 汇总成一张表：事业部、科目、账面金额、表内金额、差异、原因；",
    "6. 表下写三条改进建议；",
    "7. 结果存成 reports/2026-09-diff.md；",
    "8. 最后用三句话总结这个月的整体情况。",
    "金额保留两位小数，日期统一写成 YYYY-MM-DD。",
    "拿不准的地方先列出来，不要猜。",
  ].join("\n"),
};

/** The composer's agents chip (§6.16.29): the tree's sub-agents, how many run and wait. */
export const AGENTS_CHIP_FIXTURE: { count: number; running: number; waiting: number } = {
  count: 3,
  running: 1,
  waiting: 1,
};

// ── Agent map (§6.16.28) ────────────────────────────────────────────────────

export type FixtureAgentNode = {
  id: string;
  description: string;
  model: string;
  durationMs: number;
  tokens: number;
  status: "running" | "waiting" | "completed" | "failed" | "aborted";
  children: FixtureAgentNode[];
};

export type FixtureAgentTask = {
  id: string;
  description: string;
  status: "running" | "completed";
  /** How long it has run (running) or ran (finished). */
  durationMs: number;
};

const agentNode = (
  id: string,
  description: string,
  model: string,
  durationMs: number,
  tokens: number,
  status: FixtureAgentNode["status"],
  children: FixtureAgentNode[] = [],
): FixtureAgentNode => ({ id, description, model, durationMs, tokens, status, children });

export type FixtureAgentCall = {
  id: string;
  tool: string;
  summary: string;
  running: boolean;
  /** How long the running call has run. */
  durationMs?: number;
  range?: string;
};

export type FixtureAgentDetail = {
  agentType: string;
  spawnedBy: { id: string; label: string };
  latestText: string;
  task: string;
  /** A message the parent sent the agent while it worked (a bubble labelled with the parent). */
  message: string;
  background: FixtureAgentTask[];
  /** In call order, oldest first (the component lists them newest first). */
  toolCalls: FixtureAgentCall[];
  contextPercent: number;
};

/** The agent map: a root with four children, one of them with a child, and two background tasks. */
export const AGENT_MAP_FIXTURE: {
  root: FixtureAgentNode;
  /** The node open at level 2 (drawn selected). */
  selected: string;
  background: FixtureAgentTask[];
  /** Three levels below the root: four columns. */
  deep: FixtureAgentNode;
  /** Level 2 and 3 of the selected node (`am_invoice`). */
  detail: FixtureAgentDetail;
} = {
  root: agentNode("am_root", "整理季度经营报告", "opus 5.5", 2_538_000, 392_700, "running", [
    agentNode("am_sales", "汇总各区域销售数据", "opus 5.5", 724_000, 188_200, "completed"),
    agentNode("am_invoice", "核对供应商发票与付款记录", "opus 5.5", 985_000, 266_500, "running", [
      agentNode("am_review", "复查发票核对结果", "sonnet 5.5", 67_000, 108_800, "running"),
    ]),
    agentNode("am_summary", "起草管理层摘要", "opus 5.5", 280_000, 41_000, "waiting"),
    agentNode("am_appendix", "翻译附录表格", "haiku 5.5", 192_000, 30_400, "failed"),
  ]),
  selected: "am_invoice",
  background: [
    { id: "bg_dev", description: "启动本地预览服务", status: "running", durationMs: 482_000 },
    { id: "bg_test", description: "跑全量数据校验", status: "completed", durationMs: 221_000 },
  ],
  deep: agentNode("am_d0", "整理季度经营报告", "opus 5.5", 2_538_000, 392_700, "running", [
    agentNode("am_d1", "核对供应商发票与付款记录", "opus 5.5", 985_000, 266_500, "running", [
      agentNode("am_d2", "复查发票核对结果", "sonnet 5.5", 312_000, 108_800, "running", [
        agentNode("am_d3", "抽查十张大额发票", "haiku 5.5", 41_000, 12_300, "running"),
      ]),
    ]),
    agentNode("am_d1b", "汇总各区域销售数据", "opus 5.5", 724_000, 188_200, "completed"),
  ]),
  detail: {
    agentType: "财务助手",
    spawnedBy: { id: "am_root", label: "整理季度经营报告" },
    latestText: "三月份还差 4 笔付款没对上，现在跑一遍核对脚本。",
    task: "核对第一季度供应商发票与付款记录：以 ERP 导出的付款流水为准，逐笔匹配发票号、金额和收款方，列出未匹配和金额不一致的记录，按供应商汇总后交回。",
    message: "先核对三月份，一二月的已经由财务确认过。",
    background: [
      { id: "bg_sync", description: "同步 ERP 付款流水", status: "running", durationMs: 95_000 },
    ],
    toolCalls: [
      { id: "tc1", tool: "Read", summary: "finance/q1/README.md", running: false },
      { id: "tc2", tool: "Bash", summary: "列出一季度发票文件", running: false },
      { id: "tc3", tool: "Grep", summary: "invoice_no", running: false },
      {
        id: "tc4",
        tool: "Read",
        summary: "finance/q1/payments-2026-03.csv",
        running: false,
        range: "第 1–180 行",
      },
      { id: "tc5", tool: "Bash", summary: "按供应商汇总付款金额", running: false },
      { id: "tc6", tool: "Edit", summary: "finance/q1/reconcile.py", running: false },
      { id: "tc7", tool: "Bash", summary: "运行核对脚本", running: true, durationMs: 12_000 },
    ],
    contextPercent: 31,
  },
};
