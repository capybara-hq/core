import { describe, expect, it } from "vitest";
import {
  answerSummary,
  approvalCard,
  approvalToolName,
  CARD_SUMMARY_MAX,
  callSummary,
  connectUrl,
  KEY_ARG_MAX,
  keyArgument,
  maskSecrets,
  webBase,
} from "../../src/channels/cards.js";
import {
  busyLockAction,
  closingText,
  deliverBackoff,
  deliverJobId,
  followUpJobId,
  idempotencyKey,
} from "../../src/channels/outbound.js";

describe("IM 卡片内容", () => {
  it("an approval card names the tool like the web: <display name> [<tool>], builtins by name", () => {
    const connector = { id: "c1", name: "CRM", slug: "crm" };
    expect(
      approvalToolName(
        { toolKey: "mcp__crm__delete", toolName: "delete", connector, extension: null },
        "en",
      ),
    ).toBe("CRM [delete]");
    const extension = { name: "todo", displayName: { zh: "待办", en: "Todo" } };
    const ext = {
      toolKey: "plugin__todo__write",
      toolName: "plugin__todo__write",
      connector: null,
      extension,
    };
    expect(approvalToolName(ext, "zh")).toBe("待办 [write]");
    expect(approvalToolName(ext, "en")).toBe("Todo [write]");
    expect(
      approvalToolName(
        { toolKey: "Bash", toolName: "Bash", connector: null, extension: null },
        "zh",
      ),
    ).toBe("Bash");
  });

  it("masks credential-like keys at any depth, by whole words", () => {
    const masked = maskSecrets({
      q: "weather",
      apiKey: "sk-1",
      nested: [{ password: "p", Authorization: "Bearer x", ok: 1 }],
      client_secret: "s",
      access_token: "t",
    });
    expect(masked).toEqual({
      q: "weather",
      apiKey: "***",
      nested: [{ password: "***", Authorization: "***", ok: 1 }],
      client_secret: "***",
      access_token: "***",
    });
    // 只按整词匹配：max_tokens / token_count / keyboard 不是凭据
    expect(
      maskSecrets({
        max_tokens: 5,
        token_count: 2,
        keyboard: "k",
        refreshToken: "r",
        "x-api-key": "a",
      }),
    ).toEqual({
      max_tokens: 5,
      token_count: 2,
      keyboard: "k",
      refreshToken: "***",
      "x-api-key": "***",
    });
  });

  it("the call line: the summary in the card language, else the title and key argument", () => {
    const summary = { zh: "添加市场源 https://x", en: "Add marketplace source https://x" };
    const input = { action: "call", params: { instructions: "the whole prompt" } };
    expect(callSummary({ summary, input }, undefined, "zh")).toBe("添加市场源 https://x");
    expect(callSummary({ summary, input }, undefined, "en")).toBe(
      "Add marketplace source https://x",
    );
    // no summary: the declared title and the first declared key argument present
    const fetchInfo = { title: "Fetch a page", keyArgs: ["url", "prompt"] };
    expect(
      callSummary(
        { summary: null, input: { prompt: "p", url: "https://a.example" } },
        fetchInfo,
        "en",
      ),
    ).toBe("Fetch a page: https://a.example");
    // no title: the key argument alone; no declared key argument: the first string input
    expect(
      callSummary({ summary: null, input: { command: "npm test\nmore" } }, undefined, "en"),
    ).toBe("npm test");
    expect(
      callSummary({ summary: null, input: { n: 1 } }, { title: "Count", keyArgs: [] }, "en"),
    ).toBe("Count");
    expect(callSummary({ summary: null, input: {} }, undefined, "en")).toBe("");
    // never raw JSON, never a credential, redacted by value, cut short
    const line = callSummary(
      {
        summary: null,
        input: { apiKey: "sk-1", description: "d", note: "pre app-secret-1234567 post", n: 2 },
      },
      undefined,
      "en",
      (s) => s.replaceAll("app-secret-1234567", "[REDACTED]"),
    );
    expect(line).toBe("pre [REDACTED] post");
    expect(line).not.toContain("{");
    expect(keyArgument({ token: "t", q: "x".repeat(500) }, ["token"])).toHaveLength(KEY_ARG_MAX);
    expect(keyArgument({ q: 3 }, ["q"])).toBe("3");
    const long = callSummary(
      { summary: { zh: "x".repeat(900), en: "x".repeat(900) }, input },
      undefined,
      "en",
    );
    expect(long).toHaveLength(CARD_SUMMARY_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("答案摘要、链接拼接", () => {
    expect(answerSummary({ color: "blue" })).toBe("blue");
    expect(answerSummary({ a: ["x", "y"], b: true })).toBe("x, y; true");
    expect(answerSummary(null)).toBeUndefined();
    expect(webBase("https://cap.example/")).toBe("https://cap.example");
    expect(webBase(undefined)).toBeUndefined();
    expect(connectUrl("https://cap.example", "app 1")).toBe(
      "https://cap.example/account/connections#connector-app%201",
    );
  });

  it("投递任务 id 不含冒号；退避优先用平台给的等待时长", () => {
    expect(deliverJobId("c1", 7)).toBe("deliver-c1-7");
    expect(deliverJobId("c1", 7)).not.toContain(":");
    expect(deliverBackoff(1)).toBe(1000);
    expect(deliverBackoff(3)).toBe(4000);
    expect(deliverBackoff(30)).toBe(60_000);
  });

  it("N1：结束后复核用独立 job id（不会被仍在运行的同 seq 任务去重吞掉）；锁被占时的分支", () => {
    const a = followUpJobId("c1", 6);
    const b = followUpJobId("c1", 6);
    expect(a).not.toBe(deliverJobId("c1", 6));
    expect(a).not.toBe(b);
    expect(a.startsWith("deliver-c1-6-f")).toBe(true);
    expect(a).not.toContain(":");
    // 锁刚被释放（读不到持有者）→ 再取一次；自己上一次尝试 → 推迟；别的任务 → 结束（它结束时会复核）
    expect(busyLockAction(null, "deliver-c1-6.")).toBe("retry");
    expect(busyLockAction("deliver-c1-6.abc", "deliver-c1-6.")).toBe("requeue");
    expect(busyLockAction("deliver-c1-5.abc", "deliver-c1-6.")).toBe("drop");
  });

  it("N2：草稿收尾文本只在失败时加失败说明；中止用「已停止」；其余不改草稿", () => {
    expect(closingText("Part", "failed", "en")).toBe(
      "Part\n\nSorry, something went wrong. Please try again later.",
    );
    expect(closingText(undefined, "failed", "en")).toBe(
      "Sorry, something went wrong. Please try again later.",
    );
    expect(closingText("Part", "stopped", "en")).toBe("Part\n\nStopped.");
    expect(closingText("  ", "stopped", "zh")).toBe("已停止。");
    expect(closingText("Part", "none", "en")).toBeUndefined();
    expect(closingText(undefined, "none", "en")).toBeUndefined();
  });

  it("N3：幂等键为稳定哈希，32 个 [A-Za-z0-9_-] 字符", () => {
    const k1 = idempotencyKey("conversation-0123-4567-89ab-cdef-42");
    expect(k1).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(idempotencyKey("conversation-0123-4567-89ab-cdef-42")).toBe(k1);
    expect(idempotencyKey("conversation-0123-4567-89ab-cdef-43")).not.toBe(k1);
  });
});

describe("a Platform confirmation card", () => {
  const view = {
    id: "ap1",
    toolKey: "Platform:marketplaces.add",
    toolName: "Platform",
    connector: null,
    extension: null,
    agent: { id: "ag1", name: "Helper" },
    input: { action: "call", operation: "marketplaces.add", params: { url: "https://x" } },
    summary: { zh: "添加市场源 https://x", en: "Add marketplace source https://x" },
    scopes: ["once"],
    requestedFor: "a1",
    expiresAt: "2026-11-07T12:00:00.000Z",
    status: "pending",
    decidedBy: null,
    denyReason: null,
    conversationPath: "/chat/c1",
  };
  const deps = (v: object) =>
    ({
      db: {} as never,
      approvals: { describe: async () => v },
      registry: {
        builtinSpecs: () => [
          { name: "Bash", description: "", inputSchema: {}, title: "Run", keyArgs: ["command"] },
        ],
        extensionToolSpecs: () => [],
      },
    }) as never;

  it("names the operation, leads with the summary in the card language and offers only once", async () => {
    const zh = await approvalCard(deps(view), "ap1", "https://cap.example", "zh");
    expect(zh).toMatchObject({
      toolName: "Platform [marketplaces.add]",
      scopes: ["once"],
    });
    // the summary only: the raw call input (with the whole prompt) never reaches the IM
    expect(zh?.inputPreview).toBe("添加市场源 https://x");
    const en = await approvalCard(deps(view), "ap1", "https://cap.example", "en");
    expect(en?.inputPreview).toBe("Add marketplace source https://x");
  });

  it("a call without a summary shows the tool title and key argument, and the approval's scopes", async () => {
    const plain = {
      ...view,
      orgId: "o1",
      toolKey: "Bash",
      summary: null,
      input: { description: "run the tests", command: "pnpm test", timeout: 5 },
      scopes: ["once", "session", "always"],
    };
    const card = await approvalCard(deps(plain), "ap1", "https://cap.example", "en");
    expect(card?.scopes).toEqual(["once", "session", "always"]);
    expect(card?.inputPreview).toBe("Run: pnpm test");
  });
});
