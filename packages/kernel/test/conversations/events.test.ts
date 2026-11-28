import { describe, expect, it } from "vitest";
import {
  ContentBlockSchema,
  ConversationEventSchema,
  refFileId,
} from "../../src/conversations/events.js";

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
    const ref = { kind: "ref", fileId: "3f0c1a52-6b7e-4f43-9a9b-2c1d0e8f7a61" };
    const img = { type: "image", mediaType: "image/png", source: ref, name: "a.png" };
    const pdf = { type: "document", mediaType: "application/pdf", source: ref };
    expect(ContentBlockSchema.parse(img)).toEqual(img);
    expect(ContentBlockSchema.parse(pdf)).toEqual(pdf);
    const b64 = { kind: "base64", data: "AAAA" };
    expect(ContentBlockSchema.safeParse({ ...img, source: b64 }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...pdf, source: b64 }).success).toBe(false);
    expect(
      ContentBlockSchema.safeParse({ ...img, source: { kind: "ref", fileId: "" } }).success,
    ).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...img, mediaType: "image/svg+xml" }).success).toBe(
      false,
    );
    expect(ContentBlockSchema.safeParse({ ...pdf, mediaType: "image/png" }).success).toBe(false);
    // fileId must be a UUID (the alias too); name is at most 255 chars, no control characters
    for (const key of ["fileId", "attachmentId"]) {
      expect(
        ContentBlockSchema.safeParse({ ...img, source: { kind: "ref", [key]: "att_1" } }).success,
      ).toBe(false);
    }
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

  it("a ref logged before the file library (attachmentId) parses to fileId; a new one round-trips", () => {
    const id = "3f0c1a52-6b7e-4f43-9a9b-2c1d0e8f7a61";
    const old = {
      type: "file",
      mediaType: "application/zip",
      source: { kind: "ref", attachmentId: id },
    };
    expect(ContentBlockSchema.parse(old)).toEqual({ ...old, source: { kind: "ref", fileId: id } });
    const fresh = { ...old, source: { kind: "ref", fileId: id } };
    expect(ContentBlockSchema.parse(fresh)).toEqual(fresh);
    expect(ContentBlockSchema.parse(JSON.parse(JSON.stringify(fresh)))).toEqual(fresh);
    // both keys: fileId wins, the old key is dropped
    const other = "00000000-0000-4000-8000-000000000001";
    expect(
      ContentBlockSchema.parse({
        ...old,
        source: { kind: "ref", fileId: id, attachmentId: other },
      }),
    ).toEqual(fresh);
  });
});

describe("refFileId", () => {
  it("reads the id of a stored ref under either key", () => {
    const id = "3f0c1a52-6b7e-4f43-9a9b-2c1d0e8f7a61";
    expect(refFileId({ kind: "ref", fileId: id })).toBe(id);
    // a payload read back as stored, logged before the rename
    expect(refFileId(JSON.parse(`{"kind":"ref","attachmentId":"${id}"}`))).toBe(id);
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

  it("model_call.request.media: optional, recorded with mediaBudgetBytes; outcome limited, etag optional", () => {
    const call = (media?: unknown, budget: number | null = media === undefined ? null : 1) =>
      ConversationEventSchema.safeParse({
        type: "model_call",
        payload: modelCall({
          ...(media !== undefined && { media }),
          ...(budget !== null && { mediaBudgetBytes: budget }),
        }),
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
    // media and its budget are recorded together
    expect(call([{ attachmentId: uuid(1), outcome: "bytes" }], null)).toBe(false);
    expect(call(undefined, 1)).toBe(false);
  });
});

/** A model_call payload with every field the runtime records, `request` merged with `over`. */
function modelCall(over: Record<string, unknown> = {}) {
  return {
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
      maxOutputTokens: 4096,
      params: {},
      absorbedUpToSeq: 1,
      tools: [],
      ...over,
    },
  };
}

describe("model_call.request", () => {
  it("requires the fields the runtime always records", () => {
    const parse = (payload: unknown) =>
      ConversationEventSchema.safeParse({ type: "model_call", payload }).success;
    expect(parse(modelCall())).toBe(true);
    for (const field of ["tools", "params", "absorbedUpToSeq", "maxOutputTokens"]) {
      const p = modelCall();
      delete (p.request as Record<string, unknown>)[field];
      expect(parse(p), field).toBe(false);
    }
  });

  it("toolsOmitted is only ever true", () => {
    const parse = (toolsOmitted: unknown) =>
      ConversationEventSchema.safeParse({
        type: "model_call",
        payload: modelCall({ toolsOmitted }),
      }).success;
    expect(parse(true)).toBe(true);
    expect(parse(false)).toBe(false);
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

describe("compaction model field", () => {
  const summary = (model?: unknown) =>
    ConversationEventSchema.safeParse({
      type: "compaction_summary",
      payload: { coversUpToSeq: 4, text: "s", savedTokens: 0, step: 0, model },
    }).success;
  const failed = (model?: unknown) =>
    ConversationEventSchema.safeParse({
      type: "compaction_failed",
      payload: { attempt: 1, reason: "r", step: 0, model },
    }).success;

  it("compaction_summary and compaction_failed parse with and without model", () => {
    const ref = { provider: "p", model: "m" };
    expect([summary(ref), summary(), failed(ref), failed()]).toEqual([true, true, true, true]);
  });

  it("a model without its model name fails", () => {
    expect(summary({ provider: "p" })).toBe(false);
    expect(failed({ provider: "p" })).toBe(false);
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

describe("approval_requested", () => {
  it("records every rule that can ask, a member's own tool policy too (ApprovalPolicySource)", () => {
    const requested = (policy: string) =>
      ConversationEventSchema.safeParse({
        type: "approval_requested",
        payload: {
          step: 1,
          callId: "c1",
          approvalId: "a1",
          toolKey: "github__create_issue",
          expiresAt: "2026-11-23T00:00:00.000Z",
          policy,
          requestedFor: "acc1",
          approverRole: null,
        },
      }).success;
    for (const p of ["agent", "connector", "member", "default", "role", "org", "fixed"]) {
      expect(requested(p), p).toBe(true);
    }
  });
});

describe("run_started.compactOrigin and run_aborted superseded", () => {
  const started = (extra: Record<string, unknown>) =>
    ConversationEventSchema.safeParse({
      type: "run_started",
      payload: {
        agentVersion: 1,
        model: { provider: "p", model: "m" },
        triggerAccountId: "acc1",
        ...extra,
      },
    }).success;

  it("accepts an idle or manual compact origin and refuses another", () => {
    expect(started({ trigger: "compact", compactOrigin: "idle" })).toBe(true);
    expect(started({ trigger: "compact", compactOrigin: "manual" })).toBe(true);
    expect(started({ trigger: "compact", compactOrigin: "other" })).toBe(false);
  });

  it("parses a run_started written without the field", () => {
    expect(started({ trigger: "compact" })).toBe(true);
    expect(started({})).toBe(true);
  });

  it("accepts a superseded abort with no account", () => {
    expect(
      ConversationEventSchema.safeParse({
        type: "run_aborted",
        payload: { byAccountId: null, reason: "superseded" },
      }).success,
    ).toBe(true);
  });
});
