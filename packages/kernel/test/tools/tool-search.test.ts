import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildModelRequest, type RequestTool } from "../../src/runtime/context/build.js";
import {
  CATALOG_HEADER,
  catalogLine,
  catalogText,
  notLoadedText,
  searchTools,
  TOOL_SEARCH_SPEC,
  tokenize,
  toolSearchTool,
} from "../../src/tools/builtins/tool-search.js";
import type { ResolvedTool } from "../../src/tools/registry.js";
import { AGENT, Log, MODEL } from "../runtime/context/fixtures.js";

const spec = (name: string, description: string): ToolSpec => ({
  name,
  description,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
});

const tool = (key: string, description = `Tool ${key}.`): RequestTool => ({
  key,
  spec: spec(key.split("__").at(-1) as string, description),
  specHash: `h-${key}`,
});

const resolved = (t: RequestTool): ResolvedTool => ({
  ...t,
  source: { kind: "plugin", plugin: t.key.split("__")[0] as string, name: t.spec.name },
  defaultPolicy: "allow",
});

const CATALOG = [
  tool("crm__create_contact", "Create a contact in the CRM."),
  tool("crm__search_contacts", "Search CRM contacts by name or email."),
  tool("docs__search", "Full-text search over company documents."),
  tool("docs__read_page", "Read one document page by id."),
  tool("calendar__create_event", "Create a calendar event.\nSecond line is not in the catalog."),
];

const SEARCH = tool("tool_search", TOOL_SEARCH_SPEC.description);
const ASK = tool("ask_user", "Ask the user.");

describe("tool_search 评分与目录", () => {
  it("分词：key 按 __ / _ / - / 驼峰切开，转小写，去掉标点", () => {
    expect(tokenize("crm__searchContacts by-Email!")).toEqual([
      "crm",
      "search",
      "contacts",
      "by",
      "email",
    ]);
  });

  it("关键词评分：匹配 key 与描述，按分数降序、同分按 key 升序；不匹配的不返回；确定性", () => {
    const a = searchTools("search contacts", CATALOG, 10).map((t) => t.key);
    expect(a[0]).toBe("crm__search_contacts");
    expect(a).toContain("docs__search");
    expect(a).not.toContain("calendar__create_event");
    // 输入顺序不影响结果
    expect(searchTools("search contacts", [...CATALOG].reverse(), 10).map((t) => t.key)).toEqual(a);
    // 同分按 key
    expect(searchTools("create", CATALOG, 10).map((t) => t.key)).toEqual([
      "calendar__create_event",
      "crm__create_contact",
    ]);
    expect(searchTools("create", CATALOG, 1).map((t) => t.key)).toEqual(["calendar__create_event"]);
    expect(searchTools("nothing-matches-here", CATALOG, 10)).toEqual([]);
  });

  it("目录行：`- <key>: <描述第一行>`，按 key 排序；过长截断", () => {
    expect(catalogLine(CATALOG[4] as RequestTool)).toBe(
      "- calendar__create_event: Create a calendar event.",
    );
    const long = tool("x__y", "a".repeat(500));
    expect(catalogLine(long).length).toBeLessThanOrEqual(4 + 3 + 200 + 1);
    const text = catalogText([...CATALOG].reverse());
    expect(text.startsWith(CATALOG_HEADER)).toBe(true);
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.map((l) => l.slice(2, l.indexOf(":")))).toEqual([
      "calendar__create_event",
      "crm__create_contact",
      "crm__search_contacts",
      "docs__read_page",
      "docs__search",
    ]);
  });

  it("未加载错误文案（英文、可执行）", () => {
    expect(notLoadedText("docs__search")).toBe(
      'Tool "docs__search" is not loaded. Call tool_search first with keywords for this tool, then call it in a later step.',
    );
  });

  it("tool_search 工具：返回匹配工具的完整定义并带 loadedTools；内置工具不参与搜索", async () => {
    const t = toolSearchTool();
    expect(t.spec).toBe(TOOL_SEARCH_SPEC);
    expect(t.defaultPolicy).toBe("allow");
    const r = (await t.run(
      { query: "search documents", limit: 2 },
      {
        orgId: "o",
        accountId: "a",
        agentId: "g",
        conversationId: "c",
        callId: "x",
        signal: new AbortController().signal,
        tools: [...CATALOG, SEARCH, ASK].map(resolved),
      },
    )) as { content: { type: string; text: string }[]; loadedTools: string[] };
    expect(r.loadedTools).toEqual(["docs__search", "crm__search_contacts"]);
    const text = r.content[0]?.text as string;
    expect(text).toContain("docs__search");
    expect(text).toContain("Full-text search over company documents.");
    expect(text).toContain('"properties":{"q":{"type":"string"}}');
    expect(text).not.toContain("ask_user");

    const none = (await t.run(
      { query: "zzz" },
      {
        orgId: "o",
        accountId: "a",
        agentId: "g",
        conversationId: "c",
        callId: "y",
        signal: new AbortController().signal,
        tools: CATALOG.map(resolved),
      },
    )) as { content: { type: string; text: string }[]; loadedTools: string[] };
    expect(none.loadedTools).toEqual([]);
    expect(none.content[0]?.text).toMatch(/^No tools matched "zzz"\./);
  });
});

describe("buildModelRequest 的 tool_search 模式", () => {
  const build = (log: Log, tools: RequestTool[], toolSearch: boolean) =>
    buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
      tools,
      toolSearch,
    });

  /** tool_search 的一次调用与结果（结果带 loadedTools）。 */
  function loaded(log: Log, callId: string, keys: string[]) {
    log.assistant(
      [{ type: "tool_call", id: callId, name: "tool_search", input: { query: "x" } }],
      "tool_use",
    );
    log.add({
      type: "tool_result",
      payload: {
        step: 1,
        callId,
        toolKey: "tool_search",
        content: "loaded",
        isError: false,
        ...(keys.length > 0 && { loadedTools: keys }),
      },
    });
  }

  it("未启用：全部工具直接放完整定义（组织关闭 / 未达阈值），system 只有一个块，meta 没有 catalog", () => {
    const log = new Log();
    log.user("hi");
    const { request, meta } = build(log, [...CATALOG, ASK], false);
    expect(request.tools).toHaveLength(6);
    expect(request.system).toHaveLength(1);
    expect(meta).not.toHaveProperty("catalog");
  });

  it("启用：tools 只有内置工具（含 tool_search）；其余进 system 第二个块的目录（按 key 排序）；meta 记录 catalog", () => {
    const log = new Log();
    log.user("hi");
    const a = build(log, [...CATALOG, SEARCH, ASK], true);
    expect(a.request.tools.map((t) => t.name)).toEqual(["ask_user", "tool_search"]);
    expect(a.request.system).toHaveLength(2);
    expect(a.request.system[1]).toEqual({ text: catalogText(CATALOG), cache: true });
    expect(a.meta.catalog?.map((c) => c.key)).toEqual([
      "calendar__create_event",
      "crm__create_contact",
      "crm__search_contacts",
      "docs__read_page",
      "docs__search",
    ]);
    expect(a.meta.catalog?.[0]).toEqual({
      key: "calendar__create_event",
      specHash: "h-calendar__create_event",
    });
    // 传入顺序不影响请求
    const b = build(log, [ASK, SEARCH, ...[...CATALOG].reverse()], true);
    expect(b.request).toEqual(a.request);
    expect(b.meta).toEqual(a.meta);
  });

  it("已加载集合由日志还原：tool_result.loadedTools 的并集，按首次加载顺序追加在内置工具之后；目录不变", () => {
    const log = new Log();
    log.user("hi");
    const before = build(log, [...CATALOG, SEARCH, ASK], true);
    loaded(log, "c1", ["docs__search", "crm__search_contacts"]);
    loaded(log, "c2", ["crm__create_contact", "docs__search"]);
    loaded(log, "c3", []);
    const after = build(log, [...CATALOG, SEARCH, ASK], true);
    expect(after.request.tools.map((t) => t.name)).toEqual([
      "ask_user",
      "tool_search",
      "docs__search",
      "crm__search_contacts",
      "crm__create_contact",
    ]);
    expect(after.meta.tools.map((t) => t.key)).toEqual(after.request.tools.map((t) => t.name));
    expect(after.request.tools[2]).toEqual({
      name: "docs__search",
      description: "Full-text search over company documents.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    });
    // 目录与 system 不随加载变化（缓存前缀稳定）
    expect(after.request.system).toEqual(before.request.system);
    expect(after.meta.systemHash).toBe(before.meta.systemHash);
    // 重放：同一日志再构建一次结果一致
    expect(build(log, [...CATALOG, SEARCH, ASK], true)).toEqual(after);
  });

  it("压缩摘要之前加载的工具仍保持加载；已不可用的已加载工具不再发送", () => {
    const log = new Log();
    log.user("hi");
    loaded(log, "c1", ["docs__search", "gone__tool"]);
    const last = log.events.at(-1)?.seq as number;
    log.summary(last, "Earlier the agent loaded docs__search.");
    log.user("next");
    const { request } = build(log, [...CATALOG, SEARCH, ASK], true);
    expect(request.tools.map((t) => t.name)).toEqual(["ask_user", "tool_search", "docs__search"]);
  });

  it("没有工具时（如模型不支持工具）不带目录", () => {
    const log = new Log();
    log.user("hi");
    const { request, meta } = build(log, [], true);
    expect(request.system).toHaveLength(1);
    expect(meta).not.toHaveProperty("catalog");
  });
});
