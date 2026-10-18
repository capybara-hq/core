import { describe, expect, it } from "vitest";
import { injectionSecrets, redactDeep, redactorFor } from "../../src/tools/redact.js";

describe("工具结果打码", () => {
  it("bearer：整个头值与 token 都打码", () => {
    const r = redactorFor([{ headers: { Authorization: "Bearer tok-0123456789abcdef" } }]);
    expect(r("a=Bearer tok-0123456789abcdef b=tok-0123456789abcdef")).toBe(
      "a=[REDACTED] b=[REDACTED]",
    );
  });

  it("basic：base64、解码后的 user:password 与密码", () => {
    const encoded = Buffer.from("alice:pa55word-very-long").toString("base64");
    const secrets = injectionSecrets({ headers: { Authorization: `Basic ${encoded}` } });
    expect(secrets).toEqual(
      expect.arrayContaining([encoded, "alice:pa55word-very-long", "pa55word-very-long"]),
    );
    const r = redactorFor([{ headers: { Authorization: `Basic ${encoded}` } }]);
    expect(r("pw=pa55word-very-long")).toBe("pw=[REDACTED]");
  });

  it("query 与自定义头的值；短于 12 个字符的值不打码（Ruling A2）", () => {
    const r = redactorFor([
      { headers: { "X-Api-Key": "key-abcdefghijkl" }, query: { token: "q-abcdefghijklmn" } },
      { headers: { "X-Short": "short" } },
    ]);
    expect(r("key-abcdefghijkl q-abcdefghijklmn short")).toBe("[REDACTED] [REDACTED] short");
  });

  it("redactDeep 只改字符串值，不改键", () => {
    const r = redactorFor([{ headers: { "X-Api-Key": "key-abcdefghijkl" } }]);
    expect(
      redactDeep(
        {
          content: [{ type: "text", text: "echo key-abcdefghijkl" }],
          n: 1,
          "key-abcdefghijkl": true,
        },
        r,
      ),
    ).toEqual({
      content: [{ type: "text", text: "echo [REDACTED]" }],
      n: 1,
      "key-abcdefghijkl": true,
    });
  });

  it("没有注入 → 原样", () => {
    expect(redactorFor([])("anything")).toBe("anything");
  });
});
