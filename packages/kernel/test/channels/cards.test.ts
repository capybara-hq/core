import { describe, expect, it } from "vitest";
import {
  answerSummary,
  connectUrl,
  INPUT_PREVIEW_MAX,
  inputPreview,
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
  it("参数预览：凭据样式的键（任意层级）打码，截断到 500 字符", () => {
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
    // 按值打码（连接的密钥值）
    expect(
      inputPreview({ note: "pre app-secret-1234567 post" }, (s) =>
        s.replaceAll("app-secret-1234567", "[REDACTED]"),
      ),
    ).toBe('{"note":"pre [REDACTED] post"}');
    const long = inputPreview({ text: "x".repeat(2000) });
    expect(long).toHaveLength(INPUT_PREVIEW_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(inputPreview(undefined)).toBe("{}");
  });

  it("答案摘要、链接拼接", () => {
    expect(answerSummary({ color: "blue" })).toBe("blue");
    expect(answerSummary({ a: ["x", "y"], b: true })).toBe("x, y; true");
    expect(answerSummary(null)).toBeUndefined();
    expect(webBase("https://cap.example/")).toBe("https://cap.example");
    expect(webBase(undefined)).toBeUndefined();
    expect(connectUrl("https://cap.example", "app 1")).toBe(
      "https://cap.example/settings/connections#connector-app%201",
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
