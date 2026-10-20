import { type ToolCallContext, validateToolDisplay } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { askUserTool } from "../../src/tools/builtins/ask-user.js";
import { readToolOutputTool } from "../../src/tools/builtins/read-tool-output.js";
import { toolSearchTool } from "../../src/tools/builtins/tool-search.js";
import type { ResolvedTool } from "../../src/tools/registry.js";

/** 内核内置工具的显示摘要（中英文；只给界面看，不进模型上下文）。 */

const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => base;

const ctx = (over: Partial<ToolCallContext> & { tools?: ResolvedTool[] } = {}) => ({
  orgId: "o",
  accountId: "a",
  agentId: "g",
  conversationId: "c",
  callId: "call",
  signal: new AbortController().signal,
  ...over,
});

type WithDisplay = { display?: { summary: { zh: string; en: string } } };
const summaryOf = (r: unknown) => (r as WithDisplay).display?.summary;

describe("内置工具的显示摘要", () => {
  it("read_tool_output：已读取输出 {id}", async () => {
    const t = readToolOutputTool({ outputs: { load: async () => "a\nb\nc" }, config });
    const r = await t.run({ id: "out_1" }, ctx());
    expect(summaryOf(r)).toEqual({ zh: "已读取输出 out_1", en: "Read output out_1" });
    expect(validateToolDisplay((r as WithDisplay).display)).toEqual([]);
  });

  it("ask_user：回答 / 超时 / 关闭各有摘要；首次调用（等待回答）没有", async () => {
    const t = askUserTool({ config });
    const questions = [
      {
        question: "Which?",
        header: "Pick",
        multiSelect: false,
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
        ],
      },
    ];
    const answered = await t.run(
      { questions },
      ctx({ resume: { answer: { q0: "A" }, state: null } }),
    );
    expect(summaryOf(answered)).toEqual({
      zh: "用户回答了 1 个问题",
      en: "User answered 1 question",
    });
    const timedOut = await t.run(
      { questions },
      ctx({ resume: { answer: null, state: { hours: 24 } } }),
    );
    expect(summaryOf(timedOut)).toEqual({
      zh: "用户未在 24 小时内回答",
      en: "No answer within 24h",
    });
    const dismissed = await t.run({ questions }, ctx({ resume: { answer: null, state: null } }));
    expect(summaryOf(dismissed)).toEqual({
      zh: "用户关闭了提问",
      en: "User dismissed the question",
    });
    const first = await t.run({ questions }, ctx());
    expect(summaryOf(first)).toBeUndefined();
  });

  it("tool_search：搜索「query」· 加载 N 个 / 无匹配；过长的查询截断，摘要仍合法", async () => {
    const t = toolSearchTool();
    const none = await t.run({ query: "zzz" }, ctx({ tools: [] }));
    expect(summaryOf(none)).toEqual({
      zh: "搜索工具「zzz」· 无匹配",
      en: 'Searched tools for "zzz" · no match',
    });
    const long = await t.run({ query: "x".repeat(500) }, ctx({ tools: [] }));
    expect(validateToolDisplay((long as WithDisplay).display)).toEqual([]);
    const found = await t.run(
      { query: "search" },
      ctx({
        tools: [
          {
            key: "docs__search",
            spec: { name: "search", description: "Search docs.", inputSchema: { type: "object" } },
          } as unknown as ResolvedTool,
        ],
      }),
    );
    expect(summaryOf(found)).toEqual({
      zh: "搜索工具「search」· 加载 1 个",
      en: 'Searched tools for "search" · loaded 1',
    });
  });
});
