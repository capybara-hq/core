import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { caseTitle } from "../../src/evals/sets.service.js";
import type { CaseSnapshot, SnapshotEvent } from "../../src/evals/snapshot.js";

const BASE = {
  db: { url: "postgres://x" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
};

describe("evals 配置", () => {
  it("默认值", () => {
    expect(KernelConfigSchema.parse(BASE).evals).toEqual({
      orgConcurrency: 2,
      workerConcurrency: 4,
      defaultTokenCap: 1_000_000,
      maxTokenCap: 20_000_000,
      maxCasesPerSet: 500,
      maxCaseBytes: 4_194_304,
      judgeMaxOutputTokens: 1024,
      maxConsecutiveErrors: 10,
    });
  });
  it("defaultTokenCap 不能大于 maxTokenCap", () => {
    const r = KernelConfigSchema.safeParse({
      ...BASE,
      evals: { defaultTokenCap: 10, maxTokenCap: 5 },
    });
    expect(r.success).toBe(false);
  });
});

const ev = (seq: number, type: string, payload: unknown, runId: string | null = null) =>
  ({ seq, type, payload, runId, createdAt: new Date(0).toISOString() }) as SnapshotEvent;

const snap = (events: SnapshotEvent[]): CaseSnapshot => ({
  version: 1,
  orgId: "o",
  conversationId: "c",
  runId: "r2",
  agentId: "a",
  agentVersion: 1,
  events,
  definitions: {},
  toolSpecs: {},
});

describe("caseTitle", () => {
  it("取本运行 run_started 之前最近一条用户消息的文本，折叠空白，前 80 个码点", () => {
    const user = (seq: number, text: string) =>
      ev(seq, "user_message", { content: [{ type: "text", text }], authorAccountId: "u" });
    const s = snap([
      user(1, "first"),
      ev(2, "run_started", {}, "r1"),
      user(3, `  hello\n\n  ${"😀".repeat(100)}`),
      ev(4, "run_started", {}, "r2"),
      user(5, "later"),
    ]);
    expect(caseTitle(s)).toBe(`hello ${"😀".repeat(74)}`);
    expect(Array.from(caseTitle(s))).toHaveLength(80);
  });
  it("a skill invocation's title is /name args as typed, not the rendered skill", () => {
    const s = snap([
      ev(1, "user_message", {
        content: [{ type: "text", text: "The user invoked the skill ..." }],
        authorAccountId: "u",
        skill: {
          id: "s",
          version: 1,
          source: "p/",
          name: "fix-issue",
          arguments: "12",
          mode: "inline",
        },
      }),
      ev(2, "run_started", {}, "r2"),
    ]);
    expect(caseTitle(s)).toBe("/fix-issue 12");
  });
  it("没有用户消息时为空串", () => {
    expect(caseTitle(snap([ev(1, "run_started", {}, "r2")]))).toBe("");
  });
});
