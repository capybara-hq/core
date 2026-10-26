/**
 * Conversation-page fixtures (UI refresh B): the fixed sample data of the B reference blocks
 * (docs/design/reference/src) and, later, the `/dev/ui` conversation blocks. Pure data, no React.
 * Structure and counts follow the canvas conversation boards (tool calls, human in the loop,
 * sub-agents, files, right panel); every name is a placeholder (示例组织, 研究助手, Acme…).
 */

// ── Page, agent, models ─────────────────────────────────────────────────────

export type FixtureModelOption = { id: string; label: string; efforts?: string[] };
export type FixtureModelGroup = { provider: string; label: string; models: FixtureModelOption[] };

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
  stats: { turns: 14, elapsed: "1分03秒", context: "43%", status: "运行中", version: "v0.6.0" },
  user: {
    text: "帮我核对一下 9 月示例表的差异，列出原因",
    second: "看看文档目录的结构。",
  },
};

/** Composer, title bar and panel copy of the reference pages (zh; product copy goes through i18n). */
export const CONV_COPY = {
  placeholder: "输入消息，/ 使用命令",
  newPlaceholder: "想让 研究助手 做什么？",
  queueHint: "按 ↵ 立即发送，按 ⌘↵ 加入队列",
  attach: "添加附件",
  send: "发送",
  stop: "停止",
  agent: "切换 agent",
  model: "切换模型",
  effort: "思考档位",
  agentLocked: "发送第一条消息后不能再换 agent",
  modelHint: "从下一条消息起生效",
  properties: "属性面板",
  files: "文件",
  more: "更多",
  rename: "重命名",
  copyLink: "复制链接",
  delete: "删除会话",
  untitled: "未命名会话",
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
  kind: "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";
  /** The row's verb (已运行 / 已读取 / 已修改 / 已使用 / 正在运行 …). */
  verb: string;
  /** The connector or extension the tool comes from. */
  source?: string;
  /** The tool's declared title, or the shell command's `description`. */
  title: string;
  /** Key arguments, shown in body color. */
  keyArg?: string;
  /** Extra info after the key arguments (faint). */
  extra?: string;
  status: "running" | "done" | "failed";
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

const cmd = (id: string, title: string, status: FixtureTool["status"] = "done"): FixtureTool => ({
  id,
  kind: "command",
  verb: "已运行",
  title,
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
  | "hookDenied",
  FixtureTool[]
> = {
  // Two separate single calls (each one line, no box).
  single: [
    {
      id: "t_single_search",
      kind: "connector",
      verb: "已使用",
      source: "Acme 工单",
      title: "搜索工单",
      keyArg: "#反馈 本周",
      extra: "42 条",
      status: "done",
    },
    {
      id: "t_single_read",
      kind: "read",
      verb: "已读取",
      title: "",
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
      verb: "已使用",
      source: "Acme 文档",
      title: "获取文件元数据",
      status: "done",
    },
    {
      id: "t_done_8",
      kind: "connector",
      verb: "已使用",
      source: "Acme 文档",
      title: "获取文件权限",
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
      verb: "已使用",
      source: "Acme 文档",
      title: "获取文件元数据",
      status: "done",
    },
    {
      id: "t_fail_8",
      kind: "connector",
      verb: "已使用",
      source: "Acme 文档",
      title: "获取文件权限",
      status: "done",
    },
  ],
  // One command and one read of a single file: the header names the file.
  oneObject: [
    cmd("t_one_1", "检查文件编码"),
    {
      id: "t_one_2",
      kind: "read",
      verb: "已读取",
      title: "",
      keyArg: "示例流程交付说明.pdf",
      status: "done",
    },
  ],
  // Meta, connector (expanded), connector, connector failed, command (expanded).
  expanded: [
    {
      id: "t_exp_meta",
      kind: "meta",
      verb: "已加载的工具",
      title: "",
      extra: "Acme 文档 6 个",
      status: "done",
    },
    {
      id: "t_exp_conn",
      kind: "connector",
      verb: "已使用",
      source: "Acme 文档",
      title: "获取文件元数据",
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
      verb: "已使用",
      source: "Acme 文档",
      title: "获取文件权限",
      status: "done",
    },
    {
      id: "t_exp_failed",
      kind: "connector",
      verb: "已使用",
      source: "Acme 文档",
      title: "获取文件元数据",
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
      verb: "",
      title: "更新草稿里的 PDF 链接",
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
      verb: "已修改",
      title: "",
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
      verb: "已修改",
      title: "",
      keyArg: "scripts/report.py",
      status: "done",
      added: 40,
      removed: 9,
    },
    {
      id: "t_diff_3",
      kind: "edit",
      verb: "已修改",
      title: "",
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
      verb: "已运行",
      title: "",
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
      verb: "已使用",
      source: "Acme 工单",
      title: "发送消息",
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
    tool: string;
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
    approved: { tool: string; at: string; scope: string };
    denied: { tool: string; at: string; reason: string };
    answered: { answer: string };
    connected: { service: string; at: string };
  };
} = {
  approval: {
    tool: "Acme 工单: 发送消息",
    args: [
      ["channel", "#示例-支持"],
      ["text", "15 条流程已逐条核对完，可以交给你试运行……"],
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
    approved: { tool: "Acme 工单: 发送消息", at: "10:32", scope: "仅这一次" },
    denied: { tool: "Acme 表格: 写入单元格", at: "10:35", reason: "先别写，等财务确认" },
    answered: { answer: "服务费（按费用科目）" },
    connected: { service: "Acme 文档", at: "10:36" },
  },
};

/** Two queued messages (shown translucent, dashed, below the sent bubble). */
export const QUEUE_FIXTURE: { text: string }[] = [
  { text: "顺便把 PDF 也重新生成一下" },
  { text: "再按收款人汇总一张表" },
];

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
  steps?: string[];
  result?: string;
};

export const SUBAGENT_FIXTURE: {
  running: FixtureSubagent[];
  done: FixtureSubagent[];
  /** The id of the row open in the right panel. */
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
    },
    {
      id: "sa_dedupe",
      agentType: "调研",
      description: "读流程 v12 的去重代码",
      status: "running",
      toolCalls: 5,
      duration: "48 秒",
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
      steps: ["已使用 Acme 表格: 读取区域 映射表!A1:F240", "已运行 4 个命令", "已读取 示例表.xlsx"],
      result:
        "结论：示例供应商 A、B、C 属于「同收款人同科目」，流程取第一行；示例供应商 D 属于「同收款人不同科目」，取最后一行。",
    },
    {
      id: "sa_ids",
      agentType: "调研",
      description: "收集流程引用的文档 ID",
      status: "done",
      toolCalls: 9,
      duration: "41 秒",
    },
    {
      id: "sa_draft",
      agentType: "起草",
      description: "给财务的确认消息",
      status: "failed",
      toolCalls: 4,
      duration: "1分07秒",
    },
  ],
  open: "sa_tree",
  totals: { calls: 21, duration: "2分40秒" },
  panel: {
    task: "只读地列出文档文件夹「示例项目」下的完整目录树。不要移动、改名、删除、共享或修改任何文件。输出：写成 JSON 到 docs/tree.json；最终回复给出文件总数、目录深度，以及一、二级目录名称。",
    meta: "研究助手 · 子 agent · opus 5.5 · 只读工具",
    tools: "Acme 文档 6 个",
    prose: "已展开 6 层，共 214 个文件夹。正在处理「02 流程 / 10 现金预算」下的子目录……",
    current: "parentId = 1sEaKw6E…",
    footer: "子 agent 只读 · 不能和它对话",
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
