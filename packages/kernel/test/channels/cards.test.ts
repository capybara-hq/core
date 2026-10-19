import { describe, expect, it } from "vitest";
import {
  answerSummary,
  connectUrl,
  INPUT_PREVIEW_MAX,
  inputPreview,
  maskSecrets,
  webBase,
} from "../../src/channels/cards.js";
import { deliverBackoff, deliverJobId } from "../../src/channels/outbound.js";

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
      "https://cap.example/settings/connections#app-app%201",
    );
  });

  it("投递任务 id 不含冒号；退避优先用平台给的等待时长", () => {
    expect(deliverJobId("c1", 7)).toBe("deliver-c1-7");
    expect(deliverJobId("c1", 7)).not.toContain(":");
    expect(deliverBackoff(1)).toBe(1000);
    expect(deliverBackoff(3)).toBe(4000);
    expect(deliverBackoff(30)).toBe(60_000);
  });
});
