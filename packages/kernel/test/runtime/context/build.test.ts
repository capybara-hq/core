import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  type ConversationEventBody,
  ConversationEventSchema,
  type LogContentBlock,
} from "../../../src/conversations/events.js";
import {
  BEHAVIOR_RULES,
  buildModelRequest,
  type MediaBytes,
  type MediaInfo,
  readImageWindow,
  TEXT_INLINE_MAX_CHARS,
} from "../../../src/runtime/context/build.js";
import { AGENT, Log, MODEL } from "./fixtures.js";

const build = (log: Log, step = 0) =>
  buildModelRequest({ events: log.events, agent: AGENT, agentVersion: 1, model: MODEL, step });

const opaqueThinking = {
  type: "thinking" as const,
  text: "let me think",
  opaque: { provider: "model-fake", model: "fake-1", data: { signature: "sig-xyz", n: [1, 2] } },
};

describe("buildModelRequest", () => {
  it("builds system from behavior rules + instructions with a cache breakpoint", () => {
    const log = new Log();
    log.user("hi");
    const { request } = build(log);
    expect(request.system).toEqual([
      { text: `${BEHAVIOR_RULES}\n\n${AGENT.instructions}`, cache: true },
    ]);
    expect(request.model).toBe("fake-1");
    expect(request.tools).toEqual([]);
    expect(request.maxOutputTokens).toBe(MODEL.maxOutputTokens);
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(request.params).toEqual({});
  });

  it("passes the given params through unchanged and records them in meta; never reads agent params", () => {
    const log = new Log();
    log.user("hi");
    // agent 自己的 modelParams 不影响构建：参数由 runModelStep sanitize 后注入
    const agent = { ...AGENT, modelParams: { effort: "max" } };
    const input = { events: log.events, agent, agentVersion: 1, step: 0, model: MODEL };
    const params = { effort: "high", "model-fake.style": "shout" };
    const { request, meta } = buildModelRequest({ ...input, params });
    expect(request.params).toEqual(params);
    expect(meta.params).toEqual(params);
    expect(request.params).not.toBe(params);
    expect(buildModelRequest(input).request.params).toEqual({});
  });

  it("is reconstructible with params: rebuilding from model_call.request.params gives the same request", () => {
    const log = new Log();
    const q1 = log.user("q1");
    const params = { effort: "low", "model-fake.style": "plain" };
    const original = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
      absorbedUpToSeq: q1.seq,
      params,
    });
    // runModelStep 把 meta 写进 model_call.request
    const call = log.modelCall(q1.seq, 1, original.meta.params);
    expect(call.type === "model_call" && call.payload.request.params).toEqual(params);
    const recorded = call.type === "model_call" ? call.payload.request : undefined;
    const slice = log.events.filter(
      (e) => recorded && e.seq >= recorded.fromSeq && e.seq <= recorded.toSeq,
    );
    const again = buildModelRequest({
      events: slice,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
      ...(recorded?.absorbedUpToSeq !== undefined && { absorbedUpToSeq: recorded.absorbedUpToSeq }),
      ...(recorded?.params !== undefined && { params: recorded.params }),
    });
    expect(again.request).toEqual(original.request);
    expect(again.meta).toEqual(original.meta);
  });

  it("is deterministic: same events and definition give deep-equal requests and hashes", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    log.assistant([opaqueThinking, { type: "text", text: "hello" }]);
    log.user("again");
    const a = build(log);
    const b = build(log);
    expect(a.request).toEqual(b.request);
    expect(a.meta).toEqual(b.meta);
    expect(a.meta.systemHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("system text is identical across conversations for the same agent version", () => {
    const l1 = new Log("conv-1");
    l1.user("hi");
    const l2 = new Log("conv-2", 500);
    l2.user("a completely different conversation");
    l2.assistant("ok");
    l2.user("more");
    const a = build(l1, 0);
    const b = build(l2, 7);
    expect(a.request.system).toEqual(b.request.system);
    expect(a.meta.systemHash).toBe(b.meta.systemHash);
    expect(a.request.system[0]?.text).not.toContain("conv-");
  });

  it("is append-only: appending a user message keeps the previous messages as a prefix", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    log.assistant([opaqueThinking, { type: "text", text: "hello" }]);
    log.reminder("You are close to the step limit.");
    log.assistant("partial ans", "aborted");
    const r1 = build(log).request;
    log.user("next");
    const r2 = build(log).request;
    expect(r2.messages.length).toBe(r1.messages.length + 1);
    expect(r2.messages.slice(0, r1.messages.length)).toEqual(r1.messages);
    expect(r2.messages[1]).toEqual({
      role: "assistant",
      content: [opaqueThinking, { type: "text", text: "hello" }],
    });
  });

  it("replays reminders as system messages at their log position and lists their seqs", () => {
    const log = new Log();
    log.user("hi");
    log.assistant("step 0");
    const rem = log.reminder("Wrap up now.", 1);
    log.assistant("final", "end_turn", 1);
    const { request, meta } = build(log, 2);
    expect(request.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "system",
      "assistant",
    ]);
    expect(request.messages[2]).toEqual({ role: "system", content: "Wrap up now." });
    expect(meta.reminderSeqs).toEqual([rem.seq]);
  });

  it("replays aborted assistant messages with their partial text", () => {
    const log = new Log();
    log.user("hi");
    log.assistant("half an ans", "aborted");
    log.user("continue");
    const { request } = build(log);
    expect(request.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "half an ans" }],
    });
  });

  it("skips assistant messages with no content (aborted before any output)", () => {
    const log = new Log();
    log.user("hi");
    log.assistant([], "aborted");
    log.user("hello?");
    const { request } = build(log);
    expect(request.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("after compaction: starts with the summary and drops events it covers", () => {
    const log = new Log();
    log.turn(1);
    log.turn(2);
    const covered = log.events.at(-1)?.seq ?? 0;
    log.turn(3);
    const sum = log.summary(covered, "They asked two questions.");
    log.user("question 4");
    const { request, meta } = build(log);
    expect(request.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "<conversation_summary>\nThey asked two questions.\n</conversation_summary>",
        },
      ],
    });
    const texts = JSON.stringify(request.messages);
    expect(texts).not.toContain("question 1");
    expect(texts).not.toContain("answer 2");
    expect(request.messages.slice(1)).toEqual([
      { role: "user", content: [{ type: "text", text: "question 3" }] },
      { role: "assistant", content: [{ type: "text", text: "answer 3" }] },
      { role: "user", content: [{ type: "text", text: "question 4" }] },
    ]);
    expect(meta.summarySeq).toBe(sum.seq);
    expect(meta.fromSeq).toBe(covered + 1);
    expect(meta.toSeq).toBe(log.events.at(-1)?.seq);
  });

  it("uses only the latest summary", () => {
    const log = new Log();
    log.turn(1);
    log.summary(2, "old summary");
    log.turn(2);
    log.turn(3);
    log.summary(6, "new summary");
    log.user("question 4");
    const { request } = build(log);
    const texts = JSON.stringify(request.messages);
    expect(texts).toContain("new summary");
    expect(texts).not.toContain("old summary");
    expect(texts).not.toContain("question 2");
  });

  it("is reconstructible: slicing the log by meta rebuilds the same request", () => {
    const log = new Log();
    log.turn(1);
    log.turn(2);
    log.turn(3);
    log.summary(4, "summary of 1 and 2");
    log.runStarted();
    const q4 = log.user("question 4");
    log.reminder("Wrap up.");
    log.modelCall(q4.seq);
    // 第 4 问的模型调用进行中到达的插话：那次调用没有吸收它
    const late = log.user("arrived mid-step");
    log.assistant([opaqueThinking, { type: "text", text: "answer 4" }]);
    const q5 = log.user("question 5");
    // 本次请求吸收到 late，question 5 还没被吸收
    const { request, meta } = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 2,
      absorbedUpToSeq: late.seq,
    });
    expect(meta.absorbedUpToSeq).toBe(late.seq);
    const texts = request.messages.map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    );
    // 插话放在吸收它的这次调用的位置（answer 4 之后），question 5 不在请求里
    expect(texts.slice(-3)).toEqual(["Wrap up.", "answer 4", "arrived mid-step"]);
    expect(JSON.stringify(request.messages)).not.toContain("question 5");
    expect(q5.seq).toBeGreaterThan(late.seq);

    // 还原：按 meta 切片日志（含其中的 model_call），用记录下的 absorbedUpToSeq 重建
    const slice = log.events.filter(
      (e) => (e.seq >= meta.fromSeq && e.seq <= meta.toSeq) || e.seq === meta.summarySeq,
    );
    expect(slice.length).toBeLessThan(log.events.length);
    const again = buildModelRequest({
      events: slice,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 0,
      ...(meta.absorbedUpToSeq !== undefined && { absorbedUpToSeq: meta.absorbedUpToSeq }),
    });
    expect(again.request).toEqual(request);
    expect(again.meta).toEqual(meta);
  });

  it("absorbedUpToSeq: excludes later user messages; history stays append-only across steps", () => {
    const log = new Log();
    const q1 = log.user("q1");
    const step1 = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
      absorbedUpToSeq: q1.seq,
    });
    log.modelCall(q1.seq, 1);
    const mid = log.user("mid");
    log.assistant("a1", "tool_use", 1);
    // 第 1 步的请求在插话之前构建；第 2 步吸收插话
    const step2 = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 2,
      absorbedUpToSeq: mid.seq,
    });
    expect(step2.request.messages.slice(0, step1.request.messages.length)).toEqual(
      step1.request.messages,
    );
    expect(step2.request.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // 同一时刻若还没吸收插话（absorbedUpToSeq = q1），插话不进请求
    const notYet = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 2,
      absorbedUpToSeq: q1.seq,
    });
    expect(JSON.stringify(notYet.request.messages)).not.toContain("mid");
    // 没有 absorbedUpToSeq 字段的旧 model_call：视为吸收了它之前的全部消息
    const legacy = new Log();
    legacy.user("old");
    legacy.modelCall();
    legacy.assistant("old answer");
    legacy.user("new");
    const r = buildModelRequest({
      events: legacy.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
      absorbedUpToSeq: 4,
    });
    expect(r.request.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("absorbedUpToSeq: a mid-step message stays ahead of a later message absorbed by the same call", () => {
    const log = new Log();
    const first = log.user("first");
    log.modelCall(first.seq, 1);
    log.user("u mid-step");
    log.assistant("answer", "end_turn", 1);
    const v = log.user("v after reply");
    const build5 = (events = log.events) =>
      buildModelRequest({
        events,
        agent: AGENT,
        agentVersion: 1,
        model: MODEL,
        step: 2,
        absorbedUpToSeq: v.seq,
      });
    const { request, meta } = build5();
    const texts = request.messages.map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    );
    expect(texts).toEqual(["first", "answer", "u mid-step", "v after reply"]);
    // 同一规则由日志还原
    log.modelCall(v.seq, 2);
    const slice = log.events.filter((e) => e.seq >= meta.fromSeq && e.seq <= meta.toSeq);
    expect(build5(slice).request).toEqual(request);
  });

  it("meta without a summary covers the whole log", () => {
    const log = new Log("conv-1", 10);
    log.user("hi");
    log.assistant("hello");
    const { meta } = build(log);
    expect(meta).toMatchObject({ fromSeq: 10, toSeq: 11, summarySeq: null, reminderSeqs: [] });
  });

  describe("attachments the model gets as a reference", () => {
    const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const id = "11111111-2222-4333-8444-555555555555";
    const URI = `s3://bucket/kernel/org-1/attachments/${id}`;
    const body = new Uint8Array([0x50, 0x4b, 3, 4, 5, 6, 7]);

    /** A one-message conversation: the blocks are the whole user message. */
    const logWith = (blocks: LogContentBlock[]): Log => {
      const log = new Log();
      log.add(
        { type: "user_message", payload: { content: blocks, authorAccountId: "acc-1" } },
        null,
      );
      return log;
    };
    const fileBlock = (name?: string): LogContentBlock => ({
      type: "file",
      mediaType: XLSX,
      source: { kind: "ref", attachmentId: id },
      ...(name !== undefined && { name }),
      size: 1_234_567,
    });
    const fileBuild = (
      blocks: LogContentBlock[],
      info: MediaInfo = { size: 1_234_567, pages: null, uri: URI },
    ) =>
      buildModelRequest({
        events: logWith(blocks).events,
        agent: AGENT,
        agentVersion: 1,
        model: MODEL,
        step: 0,
        mediaInfo: new Map([[id, info]]),
        // the bytes exist: a file block must never send them
        media: new Map<string, MediaBytes | null>([[id, { mediaType: XLSX, data: body }]]),
      });
    const texts = (request: ModelRequest): string[] =>
      request.messages.flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
      );

    it("a file block becomes one reference line and never carries bytes", () => {
      const { request, meta, mediaTokens } = fileBuild([fileBlock("电商工行.xlsx")]);
      expect(request.messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `[Attached file "电商工行.xlsx" (${XLSX}), 1234567 bytes — this model cannot read its content. Unsigned object reference: ${URI}. Use FetchAttachment with the file name or this reference to copy it into the device.]`,
            },
          ],
        },
      ]);
      expect(texts(request).join("\n")).toContain(`Unsigned object reference: ${URI}`);
      expect(texts(request).join("\n")).toContain("Use FetchAttachment");
      expect(mediaTokens).toBe(0);
      // never the bytes, never a raw `file` block (a provider must not see one)
      expect(JSON.stringify(request)).not.toContain(Buffer.from(body).toString("base64"));
      expect(JSON.stringify(request)).not.toContain('"file"');
      expect(meta.media).toEqual([{ attachmentId: id, outcome: "reference" }]);
    });

    it("a file block with no name is labelled by the extension of its media type", () => {
      const { request } = fileBuild([fileBlock()]);
      expect(texts(request)[0]).toContain('[Attached file "file.xlsx" (');
    });

    it("a file block whose row is gone is the unavailable placeholder, not a reference", () => {
      const built = buildModelRequest({
        events: logWith([fileBlock("gone.xlsx")]).events,
        agent: AGENT,
        agentVersion: 1,
        model: MODEL,
        step: 0,
        mediaInfo: new Map(),
      });
      expect(texts(built.request)).toEqual(['[Attachment "gone.xlsx" is no longer available.]']);
    });

    it("a text attachment at the threshold is inlined whole; one character more is a reference", () => {
      const block: LogContentBlock = {
        type: "document",
        mediaType: "text/markdown",
        source: { kind: "ref", attachmentId: id },
        name: "notes.md",
      };
      const textBuild = (text: string) =>
        buildModelRequest({
          events: logWith([block]).events,
          agent: AGENT,
          agentVersion: 1,
          model: MODEL,
          step: 0,
          mediaInfo: new Map([[id, { size: text.length, pages: null, uri: URI }]]),
          media: new Map<string, MediaBytes | null>([
            [id, { mediaType: "text/markdown", data: new TextEncoder().encode(text) }],
          ]),
        });
      const at = textBuild("a".repeat(TEXT_INLINE_MAX_CHARS));
      expect(texts(at.request)).toEqual([
        `[Attached file "notes.md" (text/markdown)]\n${"a".repeat(TEXT_INLINE_MAX_CHARS)}`,
      ]);
      expect(texts(at.request).join("")).not.toContain("[Truncated");

      const over = textBuild("a".repeat(TEXT_INLINE_MAX_CHARS + 1));
      expect(texts(over.request)).toEqual([
        `[Attached file "notes.md" (text/markdown), ${TEXT_INLINE_MAX_CHARS + 1} bytes of text; not sent inline. The file is available in the device on request. Unsigned object reference: ${URI}. Use FetchAttachment with the file name or this reference to copy it into the device.]`,
      ]);
      expect(JSON.stringify(over.request)).not.toContain("aaaaaaaa");
      expect(over.mediaTokens).toBe(0);
    });
  });

  it("new subagent events are skipped by request building", () => {
    // The log writer validates every body with the schema, so these must parse
    const body = (b: unknown) => ConversationEventSchema.parse(b) as ConversationEventBody;
    const dispatch = { parentConversationId: "conv-p", parentRunId: "run-p", callId: "call-p" };
    const call = {
      type: "tool_call" as const,
      id: "call-1",
      name: "Agent",
      input: { prompt: "go" },
    };
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const extras: ConversationEventBody[] = [
      body({
        type: "subagent_dispatched",
        payload: {
          step: 0,
          callId: "call-1",
          subagentId: "conv-c",
          childRunId: "run-c",
          agentType: "general-purpose",
          description: "Look around",
          resumed: false,
          model: { provider: "model-fake", model: "fake-1" },
        },
      }),
      body({
        type: "subagent_waiting",
        payload: {
          subagentId: "conv-c",
          childRunId: "run-c",
          path: ["conv-c"],
          kind: "approval",
          approvalId: "ap-1",
          toolKey: "Bash",
          expiresAt: "2026-10-26T00:00:00.000Z",
        },
      }),
      body({
        type: "subagent_finished",
        payload: {
          subagentId: "conv-c",
          childRunId: "run-c",
          callId: "call-1",
          status: "completed",
          toolCalls: 2,
          durationMs: 1200,
          usage,
        },
      }),
    ];
    // a child log starts with the frozen effective definition
    const started = body({
      type: "subagent_started",
      payload: {
        parent: { conversationId: "conv-p", runId: "run-p", callId: "call-p", step: 0 },
        agentType: "general-purpose",
        template: { source: "general" },
        definition: {
          name: "general-purpose",
          instructions: "You are a sub-agent.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        preamble: "You were dispatched by another agent.",
        maxSteps: 30,
      },
    });
    const write = (withSubagents: boolean) => {
      const log = new Log();
      if (withSubagents) log.add(started, null);
      log.add(
        body({
          type: "user_message",
          payload: {
            content: [{ type: "text", text: "do the task" }],
            authorAccountId: "acc-1",
            ...(withSubagents && { dispatch }),
          },
        }),
        null,
      );
      log.assistant([call], "tool_use");
      if (withSubagents) for (const e of extras) log.add(e);
      log.add({
        type: "tool_result",
        payload: { step: 0, callId: "call-1", toolKey: "Agent", content: "done", isError: false },
      });
      log.assistant("finished", "end_turn", 1);
      return log;
    };
    const withSubagents = write(true);
    expect(withSubagents.events[0]?.type).toBe("subagent_started");
    const first = withSubagents.events[1];
    expect(first?.type === "user_message" && first.payload.dispatch).toEqual(dispatch);
    // the parent-side events change nothing; a child's subagent_started gives its system text
    // (rules, preamble, frozen instructions) and nothing else (Task 8)
    const child = build(withSubagents, 1).request;
    const plain = build(write(false), 1).request;
    expect({ ...child, system: [] }).toEqual({ ...plain, system: [] });
    expect(child.system).toEqual([
      {
        text: `${BEHAVIOR_RULES}\n\nYou were dispatched by another agent.\n\nYou are a sub-agent.`,
        cache: true,
      },
    ]);
    const parentOnly = write(false);
    for (const e of extras) parentOnly.add(e);
    expect(build(parentOnly, 1).request).toEqual(plain);
  });
});

describe("images from Read (vision-read design §1.4)", () => {
  const VISION = { ...MODEL, capabilities: { ...MODEL.capabilities, vision: true } };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const b64 = Buffer.from(PNG).toString("base64");
  /** Read image ids: `00000000-0000-4000-8000-0000000000NN`. */
  const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const readMedia = (n: number) => ({
    attachmentId: rid(n),
    name: `shot-${n}.png`,
    mediaType: "image/png",
    size: PNG.byteLength,
  });

  /** One tool step: an assistant message calling `ids.length` tools, each result with its images. */
  function readStep(log: Log, step: number, calls: { id: string; images: number[] }[]): void {
    log.assistant(
      calls.map((c) => ({ type: "tool_call", id: c.id, name: "Read", input: {} })),
      "tool_use",
      step,
    );
    for (const c of calls) {
      log.add({
        type: "tool_result",
        payload: {
          step,
          callId: c.id,
          toolKey: "Read",
          content: `result ${c.id}`,
          isError: false,
          ...(c.images.length > 0 && { media: c.images.map(readMedia) }),
        },
      });
    }
  }

  const mediaOf = (ids: number[]) => ({
    mediaInfo: new Map<string, MediaInfo>(
      ids.map((n) => [rid(n), { size: PNG.byteLength, pages: null, uri: `s3://b/${rid(n)}` }]),
    ),
    media: new Map<string, MediaBytes | null>(
      ids.map((n) => [rid(n), { mediaType: "image/png", data: PNG }]),
    ),
  });

  const buildRead = (log: Log, model = VISION, ids: number[] = [], window?: number) =>
    buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model,
      step: 1,
      ...mediaOf(ids),
      mediaBudgetBytes: 20_971_520,
      ...(window !== undefined && { readImagesPerRequest: window }),
    });

  it("renders a Read image after the tool results", () => {
    const log = new Log();
    log.user("look at the screenshots");
    readStep(log, 1, [
      { id: "c1", images: [1] },
      { id: "c2", images: [] },
      { id: "c3", images: [2] },
    ]);
    const { request, meta, mediaTokens } = buildRead(log, VISION, [1, 2], 6);
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", callId: "c1", content: "result c1", isError: false },
        { type: "tool_result", callId: "c2", content: "result c2", isError: false },
        { type: "tool_result", callId: "c3", content: "result c3", isError: false },
        { type: "text", text: `Image from Read (file_id ${rid(1)}):` },
        {
          type: "image",
          mediaType: "image/png",
          name: "shot-1.png",
          source: { kind: "base64", data: b64 },
        },
        { type: "text", text: `Image from Read (file_id ${rid(2)}):` },
        {
          type: "image",
          mediaType: "image/png",
          name: "shot-2.png",
          source: { kind: "base64", data: b64 },
        },
      ],
    });
    expect(meta.media).toEqual([
      { attachmentId: rid(1), outcome: "bytes" },
      { attachmentId: rid(2), outcome: "bytes" },
    ]);
    expect(meta.readImagesPerRequest).toBe(6);
    expect(mediaTokens).toBe(3200);
  });

  it("non-vision model gets the static Read text", () => {
    const log = new Log();
    log.user("look");
    readStep(log, 1, [{ id: "c1", images: [1] }]);
    // the bytes exist: a model without vision must never get them
    const { request, meta, mediaTokens } = buildRead(log, MODEL, [1], 6);
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", callId: "c1", content: "result c1", isError: false },
        { type: "text", text: `Image from Read (file_id ${rid(1)}):` },
        { type: "text", text: "[This model cannot view images.]" },
      ],
    });
    expect(meta.media).toEqual([{ attachmentId: rid(1), outcome: "placeholder_unsupported" }]);
    expect(mediaTokens).toBe(0);
    expect(JSON.stringify(request)).not.toContain(b64);
  });

  it("a result whose call no assistant message carries renders no image", () => {
    const log = new Log();
    log.user("look");
    log.add({
      type: "tool_result",
      payload: {
        step: 1,
        callId: "orphan",
        toolKey: "Read",
        content: "x",
        isError: false,
        media: [readMedia(1)],
      },
    });
    const { request, meta } = buildRead(log, VISION, [1], 6);
    expect(JSON.stringify(request)).not.toContain(rid(1));
    expect(meta.media).toBeUndefined();
    expect(meta.readImagesPerRequest).toBeUndefined();
  });

  it("Read window evicts in chunks", () => {
    const log = new Log();
    log.user("read them one by one");
    const keptAt: number[][] = [];
    const prefixes: string[] = [];
    for (let n = 1; n <= 11; n++) {
      readStep(log, n, [{ id: `c${n}`, images: [n] }]);
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const { request, meta } = buildRead(log, VISION, ids, 6);
      keptAt.push(
        (meta.media ?? []).flatMap((m) =>
          m.outcome === "bytes" ? [Number(m.attachmentId.slice(-12))] : [],
        ),
      );
      const json = JSON.stringify(request.messages);
      prefixes.push(json.slice(0, json.indexOf('"type":"image"')));
      // a dropped image renders the window's text, never its label or bytes
      for (const m of meta.media ?? []) {
        if (m.outcome !== "not_included") continue;
        expect(json).toContain(
          `[Image from Read (file_id ${m.attachmentId}) not included in this request.]`,
        );
        expect(json).not.toContain(`Image from Read (file_id ${m.attachmentId}):`);
      }
    }
    expect(keptAt).toEqual([
      [1],
      [1, 2],
      [1, 2, 3],
      [1, 2, 3, 4],
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5, 6],
      [5, 6, 7],
      [5, 6, 7, 8],
      [5, 6, 7, 8, 9],
      [5, 6, 7, 8, 9, 10],
      [9, 10, 11],
    ]);
    // the prefix before the first image block stays byte-identical between steps that do not
    // overflow (reads 2–6 and 8–10)
    for (const n of [2, 3, 4, 5, 6, 8, 9, 10]) {
      expect(prefixes[n - 1], `read ${n}`).toBe(prefixes[n - 2]);
    }
    expect(prefixes[6]).not.toBe(prefixes[5]);
    expect(prefixes[10]).not.toBe(prefixes[9]);
  });

  it("readImageWindow keeps the newest half at each overflow", () => {
    const ids = Array.from({ length: 11 }, (_, i) => String(i + 1));
    expect([...readImageWindow(ids.slice(0, 6), 6)]).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect([...readImageWindow(ids.slice(0, 7), 6)]).toEqual(["5", "6", "7"]);
    expect([...readImageWindow(ids.slice(0, 10), 6)]).toEqual(["5", "6", "7", "8", "9", "10"]);
    expect([...readImageWindow(ids, 6)]).toEqual(["9", "10", "11"]);
    // an odd window keeps floor(window / 2)
    expect([...readImageWindow(ids.slice(0, 4), 3)]).toEqual(["4"]);
    expect([...readImageWindow(ids, undefined)]).toEqual(ids);
  });

  it("Read images count toward the image cap and the byte budget like pasted ones", () => {
    const log = new Log();
    log.user("look");
    readStep(log, 1, [
      { id: "c1", images: [1] },
      { id: "c2", images: [2] },
    ]);
    const { request, meta } = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: VISION,
      step: 1,
      ...mediaOf([1, 2]),
      mediaBudgetBytes: PNG.byteLength,
      readImagesPerRequest: 6,
    });
    expect(meta.media).toEqual([
      { attachmentId: rid(1), outcome: "omitted" },
      { attachmentId: rid(2), outcome: "bytes" },
    ]);
    expect(JSON.stringify(request)).toContain('[Attachment \\"shot-1.png\\" omitted');
  });

  it("pasted placeholder names the attachment id", () => {
    const id = rid(42);
    const log = new Log();
    log.add(
      {
        type: "user_message",
        payload: {
          content: [
            { type: "image", mediaType: "image/png", source: { kind: "ref", attachmentId: id } },
          ],
          authorAccountId: "acc-1",
        },
      },
      null,
    );
    const named = new Log();
    named.add(
      {
        type: "user_message",
        payload: {
          content: [
            {
              type: "image",
              mediaType: "image/png",
              source: { kind: "ref", attachmentId: id },
              name: "cat.png",
            },
          ],
          authorAccountId: "acc-1",
        },
      },
      null,
    );
    expect(build(named).request.messages[0]?.content).toEqual([
      {
        type: "text",
        text: `[Attached image "cat.png" — this model cannot view images. Read with file_id ${id} sends it to the organization's vision model, if one is set.]`,
      },
    ]);
    expect(build(log).request.messages[0]?.content).toEqual([
      {
        type: "text",
        text: `[Attached image "attachment" — this model cannot view images. Read with file_id ${id} sends it to the organization's vision model, if one is set.]`,
      },
    ]);
  });
});
