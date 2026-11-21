import { describe, expect, it } from "vitest";
import {
  scrubToolInput,
  TOOL_REVIEW_ASK_REASON,
  TOOL_REVIEW_MAX_REASON,
  TOOL_REVIEW_SYSTEM_PROMPT,
  TOOL_REVIEW_UNAVAILABLE_PREFIX,
  ToolAskReview,
  type ToolReviewInput,
  toolReviewMessage,
  toolReviewSystemPrompt,
} from "../../src/tools/tool-review.js";

/** Profiles govern every approval, ruling R3: the pure parts of the tool review. */

const TAG = "review-0123456789abcdef";

describe("toolReviewMessage", () => {
  const message = toolReviewMessage(
    {
      toolKey: "Platform",
      title: "Create a channel connection",
      summary: { zh: "创建渠道连接 Ops", en: "Create the channel connection Ops" },
      inputText: '{"operation":"channels.create"}',
      personMessages: "please connect our Slack workspace",
    },
    TAG,
  );

  it("puts the tool key, title, summary and input inside the call's tag", () => {
    const blocks = message.split(`<${TAG}>`).slice(1);
    expect(blocks).toHaveLength(2);
    const call = blocks[0]?.split(`</${TAG}>`)[0] ?? "";
    expect(call).toContain("Tool: Platform");
    expect(call).toContain("Title: Create a channel connection");
    expect(call).toContain("Summary: Create the channel connection Ops");
    expect(call).not.toContain("创建渠道连接");
    expect(call).toContain('{"operation":"channels.create"}');
    expect(call).not.toContain("please connect");
  });

  it("puts the person's messages inside a second tagged block", () => {
    const second = message.split(`<${TAG}>`)[2]?.split(`</${TAG}>`)[0] ?? "";
    expect(second.trim()).toBe("please connect our Slack workspace");
    // nothing outside the tags but the fixed headings
    expect(message.split(`</${TAG}>`).at(-1)).toBe("");
  });

  it("says (none) for a missing title, summary or person messages", () => {
    const m = toolReviewMessage(
      { toolKey: "k", title: null, summary: null, inputText: "{}", personMessages: "  " },
      TAG,
    );
    expect(m).toContain("Title: (none)");
    expect(m).toContain("Summary: (none)");
    expect(m.split(`<${TAG}>`)[2]?.split(`</${TAG}>`)[0]?.trim()).toBe("(none)");
  });

  it("the system prompt starts with the fixed text and names the tag", () => {
    const system = toolReviewSystemPrompt(TAG);
    expect(system.startsWith(TOOL_REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain(`<${TAG}> and </${TAG}>`);
  });
});

describe("scrubToolInput", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      token: { type: "string", "x-secret": true },
      password: { type: "string", writeOnly: true },
      nested: {
        type: "object",
        properties: {
          keep: { type: "number" },
          apiKey: { type: "string", "x-secret": true },
        },
      },
      list: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, secret: { type: "string", writeOnly: true } },
        },
      },
      secrets: { type: "array", items: { type: "string", "x-secret": true } },
      askPerson: { type: "array", items: { type: "string" } },
      clearSecrets: { type: "array", items: { type: "string" } },
    },
  };

  it("drops values at x-secret and writeOnly paths, nested objects and arrays included", () => {
    const input = {
      name: "ops",
      token: "tok-SECRET",
      password: "pw-SECRET",
      nested: { keep: 1, apiKey: "key-SECRET" },
      list: [{ id: "a", secret: "item-SECRET" }, { id: "b" }],
      secrets: ["s1-SECRET", "s2-SECRET"],
      askPerson: ["token", "nested.apiKey"],
      clearSecrets: ["password"],
    };
    const out = scrubToolInput(input, schema);
    expect(out).toEqual({
      name: "ops",
      nested: { keep: 1 },
      list: [{ id: "a" }, { id: "b" }],
      secrets: [],
      askPerson: ["token", "nested.apiKey"],
      clearSecrets: ["password"],
    });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("never mutates its argument", () => {
    const input = {
      token: "t",
      nested: { keep: 1, apiKey: "k" },
      list: [{ id: "a", secret: "s" }],
    };
    const before = structuredClone(input);
    scrubToolInput(input, schema);
    expect(input).toEqual(before);
  });

  it("follows $ref, unions and additionalProperties; an unresolved $ref counts as secret", () => {
    const s = {
      type: "object",
      $defs: {
        cred: { type: "object", properties: { key: { type: "string", "x-secret": true } } },
      },
      properties: {
        viaRef: { $ref: "#/$defs/cred" },
        viaUnion: {
          anyOf: [
            { type: "null" },
            { type: "object", properties: { pass: { type: "string", writeOnly: true } } },
          ],
        },
        map: { type: "object", additionalProperties: { type: "string", "x-secret": true } },
        broken: { $ref: "#/$defs/missing" },
      },
    };
    expect(
      scrubToolInput(
        {
          viaRef: { key: "k", other: 1 },
          viaUnion: { pass: "p", user: "u" },
          map: { a: "x", b: "y" },
          broken: "z",
          free: "kept",
        },
        s,
      ),
    ).toEqual({ viaRef: { other: 1 }, viaUnion: { user: "u" }, map: {}, free: "kept" });
  });

  it("applies matching patternProperties beside properties; additionalProperties only otherwise", () => {
    const s = {
      type: "object",
      properties: { token: { type: "string" }, name: { type: "string" } },
      patternProperties: { "^tok": { type: "string", "x-secret": true } },
      additionalProperties: { type: "string", writeOnly: true },
    };
    expect(scrubToolInput({ token: "t", tokenB: "b", name: "n", extra: "e" }, s)).toEqual({
      name: "n",
    });
    const open = {
      type: "object",
      properties: { name: { type: "string" } },
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: { type: "string", "x-secret": true },
    };
    expect(scrubToolInput({ name: "n", "x-a": "a", other: "o" }, open)).toEqual({
      name: "n",
      "x-a": "a",
    });
  });

  it("a secret root yields null; scalars and missing schemas pass through", () => {
    expect(scrubToolInput("x", { type: "string", "x-secret": true })).toBeNull();
    expect(scrubToolInput({ a: 1 }, {})).toEqual({ a: 1 });
    expect(scrubToolInput(undefined, { type: "object" })).toBeUndefined();
  });
});

describe("ToolAskReview.review on hand-built dependencies", () => {
  /** A query builder whose every step returns itself and whose `execute` gives `rows`. */
  const fakeDb = (rows: () => Promise<unknown[]>) => {
    const q: Record<string, unknown> = new Proxy(
      {},
      { get: (_t, key) => (key === "execute" ? rows : () => q) },
    );
    return { db: q };
  };
  const quiet = { info() {}, warn() {}, error() {} };
  const config = { get: () => ({ sandbox: { review: { timeoutMs: 5_000, messageTokens: 200 } } }) };
  const input: ToolReviewInput = {
    orgId: "org",
    rootConversationId: "conv",
    conversationId: "conv",
    runId: "run",
    step: 1,
    callId: "call",
    accountId: "acc",
    signal: new AbortController().signal,
    toolKey: "Platform",
    title: null,
    summary: null,
    input: {},
    inputSchema: {},
    hookFacts: { accountId: "acc", agentId: "agent", agentVersion: 1, conversationKind: "chat" },
  };
  // biome-ignore lint/suspicious/noExplicitAny: hand-built fakes of the Nest providers
  const build = (over: { db?: any; purposes?: any; hooks?: any }) =>
    new ToolAskReview(
      over.db ?? fakeDb(async () => []),
      over.purposes ?? {
        chatLimits: async () => ({ contextWindow: 64_000, maxOutputTokens: 4_000 }),
        chat: async () => {
          throw new Error("not scripted");
        },
      },
      {
        appendReported: async () => ({ written: [], toSeq: null }),
        appendCounted: async () => ({ written: [], toSeq: null }),
        appendAudited: async () => [],
      },
      { notify: async () => {} },
      config as never,
      quiet,
      over.hooks === undefined ? undefined : { hooks: over.hooks },
    );

  it("clips the verdict's reason to 2000 characters", async () => {
    const long = "x".repeat(3_000);
    const review = build({
      purposes: {
        chatLimits: async () => ({ contextWindow: 64_000, maxOutputTokens: 4_000 }),
        chat: async (
          _o: string,
          _p: string,
          request: unknown,
          _s: AbortSignal,
          opts: { beforeSend: (t: unknown, r: unknown) => Promise<void> },
        ) => {
          await opts.beforeSend({ provider: "p", model: "m" }, request);
          throw new Error("unreachable: the hook denies");
        },
      },
      hooks: {
        has: () => true,
        run: async () => ({ allowed: false, plugin: "probe", reason: long, cause: "deny" }),
      },
    });
    const verdict = await review.review(input);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason.startsWith(TOOL_REVIEW_UNAVAILABLE_PREFIX)).toBe(true);
    expect(verdict.reason).toHaveLength(TOOL_REVIEW_MAX_REASON);
  });

  it("never throws: a failing read is an ask", async () => {
    const review = build({
      db: fakeDb(async () => {
        throw new Error("database down");
      }),
    });
    await expect(review.review(input)).resolves.toEqual({
      decision: "ask",
      reason: TOOL_REVIEW_ASK_REASON,
    });
  });
});
