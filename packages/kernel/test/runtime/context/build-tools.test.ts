import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { buildModelRequest, type RequestTool } from "../../../src/runtime/context/build.js";
import { compactionPlan } from "../../../src/runtime/context/compaction.js";
import { guardToolPairs } from "../../../src/runtime/context/pairing.js";
import { estimateTokens } from "../../../src/runtime/context/tokens.js";
import { AGENT, Log, MODEL } from "./fixtures.js";

const spec = (name: string, description = `Tool ${name}.`): ToolSpec => ({
  name,
  description,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
});

const tool = (key: string, hash = `h-${key}`): RequestTool => ({
  key,
  spec: spec(key.split("__").at(-1) as string),
  specHash: hash,
});

const build = (events: ConversationEvent[], tools?: RequestTool[]) =>
  buildModelRequest({
    events,
    agent: AGENT,
    agentVersion: 1,
    model: MODEL,
    step: 1,
    ...(tools !== undefined && { tools }),
  });

/** 一条工具结果事件。 */
function result(log: Log, callId: string, content: string, step = 1, isError = false) {
  return log.add({
    type: "tool_result",
    payload: { step, callId, toolKey: "docs__search", content, isError },
  });
}

describe("buildModelRequest 工具", () => {
  it("不传 tools：请求与 meta 的 tools 都为空", () => {
    const log = new Log();
    log.user("hi");
    const { request, meta } = build(log.events);
    expect(request.tools).toEqual([]);
    expect(meta.tools).toEqual([]);
  });

  it("工具按 key 排序（与传入顺序无关），name 用模型可见的 key；meta 记录 key 与指纹", () => {
    const log = new Log();
    log.user("hi");
    const tools = [tool("zeta__b"), tool("ask_user"), tool("docs__search"), tool("Docs__a")];
    const a = build(log.events, tools);
    const b = build(log.events, [...tools].reverse());
    expect(a.request.tools.map((t) => t.name)).toEqual([
      "Docs__a",
      "ask_user",
      "docs__search",
      "zeta__b",
    ]);
    expect(b.request.tools).toEqual(a.request.tools);
    expect(a.request.tools[2]).toEqual({
      name: "docs__search",
      description: "Tool search.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    });
    expect(a.meta.tools).toEqual([
      { key: "Docs__a", specHash: "h-Docs__a" },
      { key: "ask_user", specHash: "h-ask_user" },
      { key: "docs__search", specHash: "h-docs__search" },
      { key: "zeta__b", specHash: "h-zeta__b" },
    ]);
    // 不改动入参
    expect(tools.map((t) => t.key)).toEqual(["zeta__b", "ask_user", "docs__search", "Docs__a"]);
  });

  it("连接器的 connectorData 不发给模型（只进指纹与存档）", () => {
    const log = new Log();
    log.user("hi");
    const t: RequestTool = {
      key: "pets__get",
      spec: { ...spec("get"), connectorData: { method: "get", path: "/pets/{id}" } },
      specHash: "h",
    };
    const { request } = build(log.events, [t]);
    expect(request.tools).toEqual([
      {
        name: "pets__get",
        description: "Tool get.",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    expect(JSON.stringify(request)).not.toContain("/pets/{id}");
  });

  it("tool_result 事件还原为紧随 assistant 的一条 user 消息，同一步的结果按调用顺序合并", () => {
    const log = new Log();
    log.user("find both");
    log.modelCall(1, 1);
    log.assistant(
      [
        { type: "text", text: "Searching." },
        { type: "tool_call", id: "c1", name: "docs__search", input: { q: "a" } },
        { type: "tool_call", id: "c2", name: "docs__search", input: { q: "b" } },
      ],
      "tool_use",
      1,
    );
    log.add({
      type: "tool_call_started",
      payload: { step: 1, callId: "c2", toolKey: "docs__search", specHash: "h" },
    });
    // 写入顺序与调用顺序相反：仍按调用顺序还原
    result(log, "c2", "result b", 1, true);
    result(log, "c1", "result a");
    log.modelCall(1, 2);
    log.assistant("Done.", "end_turn", 2);

    const { request } = build(log.events);
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "find both" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          { type: "tool_call", id: "c1", name: "docs__search", input: { q: "a" } },
          { type: "tool_call", id: "c2", name: "docs__search", input: { q: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", callId: "c1", content: "result a", isError: false },
          { type: "tool_result", callId: "c2", content: "result b", isError: true },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    // 已成对：配对守卫不再补 unknown 结果
    expect(guardToolPairs(request.messages)).toEqual(request.messages);
  });

  it("工具执行期间到达的插话排在工具结果之后（结果紧随 assistant，保持成对）", () => {
    const log = new Log();
    log.user("go");
    log.modelCall(1, 1);
    log.assistant(
      [{ type: "tool_call", id: "c1", name: "docs__search", input: {} }],
      "tool_use",
      1,
    );
    const interjection = log.user("also check X");
    result(log, "c1", "found");
    log.modelCall(interjection.seq, 2);

    const { request } = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 2,
      absorbedUpToSeq: interjection.seq,
    });
    expect(request.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(request.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", callId: "c1", content: "found", isError: false }],
    });
    expect(request.messages[3]).toEqual({
      role: "user",
      content: [{ type: "text", text: "also check X" }],
    });
  });

  it("找不到对应调用的 tool_result 不进请求；其他 run 的同名 callId 不串用", () => {
    const log = new Log();
    log.user("hi");
    log.assistant([{ type: "tool_call", id: "c1", name: "t", input: {} }], "tool_use", 1);
    log.add(
      {
        type: "tool_result",
        payload: { step: 1, callId: "c1", toolKey: "t", content: "other run", isError: false },
      },
      "run-2",
    );
    result(log, "orphan", "nobody asked");
    const { request } = build(log.events);
    expect(request.messages).toHaveLength(2);
    // 守卫给缺结果的调用补 unknown
    expect(guardToolPairs(request.messages)[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", callId: "c1", isError: true }],
    });
  });

  it("只追加：新的工具结果与下一步只在末尾追加", () => {
    const log = new Log();
    log.user("go");
    log.assistant([{ type: "tool_call", id: "c1", name: "t", input: {} }], "tool_use", 1);
    result(log, "c1", "r1");
    const before = build(log.events).request.messages;
    log.assistant([{ type: "tool_call", id: "c2", name: "t", input: {} }], "tool_use", 2);
    result(log, "c2", "r2", 2);
    const after = build(log.events).request.messages;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 2);
  });
});

describe("estimateTokens 计入工具定义", () => {
  it("带工具的估算更大，差值为名字 + 描述 + inputSchema JSON", () => {
    const system = [{ text: "sys", cache: true }];
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];
    const base = estimateTokens(messages, system);
    const def = { name: "abcd", description: "efgh".repeat(10), inputSchema: { type: "object" } };
    const withTools = estimateTokens(messages, system, [def]);
    const extra = def.name.length + def.description.length + JSON.stringify(def.inputSchema).length;
    expect(withTools).toBe(Math.ceil((3 + 2 + extra) / 4));
    expect(withTools).toBeGreaterThan(base);
  });
});

describe("压缩边界不切开工具调用与结果", () => {
  it("工具运行期间的插话不作为边界：结果与其调用同在原文里，不被当成孤立结果丢弃", () => {
    const log = new Log();
    log.user("q1");
    log.assistant("a1");
    log.user("q2");
    log.modelCall(3, 1);
    log.assistant(
      [{ type: "tool_call", id: "c1", name: "docs__search", input: {} }],
      "tool_use",
      1,
    );
    const interjection = log.user("also check X");
    result(log, "c1", "the real output");
    log.modelCall(interjection.seq, 2);
    log.assistant("final", "end_turn", 2);

    // 只保留最近 1 轮：朴素边界会落在插话上（切开 c1 与其结果），应退到 q2
    const plan = compactionPlan(log.events, 1);
    expect(plan).not.toBeNull();
    expect(plan?.transcript).toContain("User: q1");
    expect(plan?.transcript).not.toContain("q2");
    log.summary(plan?.coversUpToSeq as number, "summary of q1");

    const { request } = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 3,
      absorbedUpToSeq: interjection.seq,
    });
    const results = request.messages.flatMap((m) =>
      m.role === "system" ? [] : m.content.filter((b) => b.type === "tool_result"),
    );
    expect(results).toEqual([
      { type: "tool_result", callId: "c1", content: "the real output", isError: false },
    ]);
    expect(guardToolPairs(request.messages)).toEqual(request.messages);
  });

  it("插话之前没有可退的轮次：不压缩这段（返回 null）", () => {
    const log = new Log();
    log.user("q1");
    log.assistant([{ type: "tool_call", id: "c1", name: "t", input: {} }], "tool_use", 1);
    log.user("interjection");
    result(log, "c1", "out");
    expect(compactionPlan(log.events, 1)).toBeNull();
  });
});

describe("压缩记录包含工具结果", () => {
  it("tool_result 事件进入对话记录", () => {
    const log = new Log();
    log.user("q1");
    log.assistant([{ type: "tool_call", id: "c1", name: "docs__search", input: {} }], "tool_use");
    result(log, "c1", "the answer", 1, true);
    log.user("q2");
    const plan = compactionPlan(log.events, 1);
    expect(plan?.transcript).toContain("Tool result docs__search (error): the answer");
  });
});
