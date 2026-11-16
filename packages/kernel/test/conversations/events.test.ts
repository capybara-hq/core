import { describe, expect, it } from "vitest";
import { ContentBlockSchema, ConversationEventSchema } from "../../src/conversations/events.js";

describe("ContentBlockSchema", () => {
  it("text 块的 opaque 原样保留（如 OpenAI message 输出项 id，回放时要用）", () => {
    const block = {
      type: "text",
      text: "391",
      opaque: { provider: "openai", model: "gpt-5.5", data: { id: "msg_1" } },
    };
    expect(ContentBlockSchema.parse(block)).toEqual(block);
    expect(ContentBlockSchema.parse({ type: "text", text: "x" })).toEqual({
      type: "text",
      text: "x",
    });
  });

  it("image / document 只认 ref：字节（base64）不进事件日志", () => {
    const ref = { kind: "ref", attachmentId: "3f0c1a52-6b7e-4f43-9a9b-2c1d0e8f7a61" };
    const img = { type: "image", mediaType: "image/png", source: ref, name: "a.png" };
    const pdf = { type: "document", mediaType: "application/pdf", source: ref };
    expect(ContentBlockSchema.parse(img)).toEqual(img);
    expect(ContentBlockSchema.parse(pdf)).toEqual(pdf);
    const b64 = { kind: "base64", data: "AAAA" };
    expect(ContentBlockSchema.safeParse({ ...img, source: b64 }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...pdf, source: b64 }).success).toBe(false);
    expect(
      ContentBlockSchema.safeParse({ ...img, source: { kind: "ref", attachmentId: "" } }).success,
    ).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...img, mediaType: "image/svg+xml" }).success).toBe(
      false,
    );
    expect(ContentBlockSchema.safeParse({ ...pdf, mediaType: "image/png" }).success).toBe(false);
    // attachmentId 必须是 UUID；name 不超过 255 字符、不含控制字符
    expect(
      ContentBlockSchema.safeParse({ ...img, source: { kind: "ref", attachmentId: "att_1" } })
        .success,
    ).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...img, name: "a".repeat(255) }).success).toBe(true);
    expect(ContentBlockSchema.safeParse({ ...img, name: "a".repeat(256) }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...img, name: "a\nb" }).success).toBe(false);
    // 整条事件也一样：带 base64 的 user_message 写不进日志
    const ev = (source: unknown) => ({
      type: "user_message",
      payload: {
        content: [
          { type: "text", text: "see" },
          { ...img, source },
        ],
        authorAccountId: "acc-1",
      },
    });
    expect(ConversationEventSchema.safeParse(ev(ref)).success).toBe(true);
    expect(ConversationEventSchema.safeParse(ev(b64)).success).toBe(false);
  });
});

describe("media_excluded 与 model_call.request.media（Ruling M8）", () => {
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const excluded = (attachmentIds: string[], reason = "provider_rejected") =>
    ConversationEventSchema.safeParse({
      type: "media_excluded",
      payload: { attachmentIds, reason },
    }).success;

  it("media_excluded：UUID、1..50 个、原因只有 provider_rejected", () => {
    expect(excluded([uuid(1)])).toBe(true);
    expect(excluded(Array.from({ length: 50 }, (_, i) => uuid(i)))).toBe(true);
    expect(excluded(Array.from({ length: 51 }, (_, i) => uuid(i)))).toBe(false);
    expect(excluded([])).toBe(false);
    expect(excluded(["att_1"])).toBe(false);
    expect(excluded([uuid(1)], "other")).toBe(false);
  });

  it("model_call.request.media：可选；outcome 限定取值，etag 可选", () => {
    const call = (media?: unknown) =>
      ConversationEventSchema.safeParse({
        type: "model_call",
        payload: {
          step: 1,
          attempt: 1,
          provider: "p",
          model: "m",
          fallback: false,
          request: {
            fromSeq: 1,
            toSeq: 2,
            summarySeq: null,
            systemHash: "h",
            reminderSeqs: [],
            ...(media !== undefined && { media }),
          },
        },
      }).success;
    expect(call()).toBe(true);
    expect(
      call([
        { attachmentId: uuid(1), outcome: "bytes", etag: "abc" },
        { attachmentId: uuid(2), outcome: "too_many_pages" },
      ]),
    ).toBe(true);
    expect(call([{ attachmentId: uuid(1), outcome: "sent" }])).toBe(false);
    expect(call([{ attachmentId: "x", outcome: "bytes" }])).toBe(false);
  });
});

describe("compaction_summary", () => {
  it("keeps savedTokens and step, both required", () => {
    const missing = ConversationEventSchema.safeParse({
      type: "compaction_summary",
      payload: { coversUpToSeq: 4, text: "summary" },
    });
    expect(missing.success).toBe(false);
    const now = ConversationEventSchema.parse({
      type: "compaction_summary",
      payload: { coversUpToSeq: 4, text: "summary", savedTokens: 1200, step: 2 },
    });
    expect(now.type === "compaction_summary" ? now.payload.savedTokens : undefined).toBe(1200);
  });

  it("keeps openingSeqs (the messages to re-render)", () => {
    const now = ConversationEventSchema.parse({
      type: "compaction_summary",
      payload: { coversUpToSeq: 9, text: "summary", openingSeqs: [3, 5], savedTokens: 0, step: 0 },
    });
    expect(now.type === "compaction_summary" ? now.payload.openingSeqs : undefined).toEqual([3, 5]);
    expect(
      ConversationEventSchema.safeParse({
        type: "compaction_summary",
        payload: { coversUpToSeq: 9, text: "summary", openingSeqs: [1.5], savedTokens: 0, step: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("project_root", () => {
  const event = (payload: Record<string, unknown>) =>
    ConversationEventSchema.safeParse({ type: "project_root", payload });

  it("a project without AGENTS.md parses with no reason, and skills default to []", () => {
    const parsed = ConversationEventSchema.parse({
      type: "project_root",
      payload: { project: "core", root: "/home/dev/core" },
    });
    expect(parsed.type === "project_root" ? parsed.payload.skills : undefined).toEqual([]);
    expect(parsed.type === "project_root" ? parsed.payload.agentsMd : "x").toBeUndefined();
  });

  it("an unusable project carries a reason code and a message, and nothing else", () => {
    const base = { project: "core", root: "/home/dev/core" };
    for (const reason of ["gone", "outside_mode", "unreadable", "unsupported"]) {
      expect(event({ ...base, unavailable: { reason, message: "Why." } }).success).toBe(true);
    }
    expect(event({ ...base, unavailable: { reason: "offline", message: "Why." } }).success).toBe(
      false,
    );
    expect(event({ ...base, unavailable: { reason: "gone", message: "" } }).success).toBe(false);
    expect(
      event({ ...base, unavailable: { reason: "gone", message: "x".repeat(501) } }).success,
    ).toBe(false);
    const gone = { reason: "gone", message: "Gone." };
    expect(event({ ...base, unavailable: gone, agentsMd: "rules" }).success).toBe(false);
    expect(event({ ...base, unavailable: gone, agentsMdTruncated: true }).success).toBe(false);
    expect(event({ ...base, unavailable: gone, skillsTruncated: true }).success).toBe(false);
    expect(
      event({
        ...base,
        unavailable: gone,
        skills: [{ name: "fix-issue", description: "Fix one issue", digest: "a1b2c3" }],
      }).success,
    ).toBe(false);
    // the free-text field is gone
    expect(event({ ...base, absent: "missing" }).success).toBe(false);
  });

  it("says when the project has more skill directories than were read", () => {
    const base = { project: "core", root: "/home/dev/core" };
    expect(event({ ...base, skillsTruncated: true }).success).toBe(true);
    expect(event({ ...base, skillsTruncated: false }).success).toBe(false);
  });

  it("carries the AGENTS.md text, the truncation flag and each skill's digest", () => {
    const payload = {
      project: "core",
      root: "/home/dev/core",
      agentsMd: "# Rules\n",
      agentsMdTruncated: true,
      skills: [{ name: "fix-issue", description: "Fix one issue", digest: "a1b2c3" }],
    };
    const parsed = ConversationEventSchema.parse({ type: "project_root", payload });
    expect(parsed).toEqual({ type: "project_root", payload });
  });

  it("refuses a skill name the catalog cannot take, and an empty project or root", () => {
    const skill = { name: "fix-issue", description: "Fix one issue", digest: "a1b2c3" };
    expect(event({ project: "core", root: "/home/dev/core" }).success).toBe(true);
    expect(event({ project: "", root: "/home/dev/core" }).success).toBe(false);
    expect(event({ project: "core", root: "" }).success).toBe(false);
    expect(
      event({ project: "core", root: "/home/dev/core", skills: [{ ...skill, name: "Fix Issue" }] })
        .success,
    ).toBe(false);
  });
});

describe("approval_decided", () => {
  const decided = (reason: string) =>
    ConversationEventSchema.safeParse({
      type: "approval_decided",
      payload: {
        approvalId: "a1",
        callId: "c1",
        decision: "denied",
        byAccountId: null,
        reason,
      },
    }).success;

  it("a deny reason is at most 500 characters, as the decision route allows", () => {
    expect(decided("x".repeat(500))).toBe(true);
    expect(decided("x".repeat(501))).toBe(false);
  });
});
