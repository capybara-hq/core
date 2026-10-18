import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/log.js";
import { Credentials } from "../../src/tools/credentials.js";
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

  it("query 与自定义头的值；短于 6 个字符的值不打码（Ruling A12）", () => {
    const r = redactorFor([
      { headers: { "X-Api-Key": "key-abcdefghijkl" }, query: { token: "q-abcdefghijklmn" } },
      { headers: { "X-Short": "short" } },
    ]);
    expect(r("key-abcdefghijkl q-abcdefghijklmn short")).toBe("[REDACTED] [REDACTED] short");
  });

  it("8 个字符的短 API key 回显也打码", () => {
    const r = redactorFor([{ headers: { "X-Api-Key": "k8Secret" } }]);
    expect(r("server saw key=k8Secret")).toBe("server saw key=[REDACTED]");
  });

  it("百分号编码形式的回显也打码", () => {
    const token = "tok/with+special=chars&more";
    const r = redactorFor([{ headers: {}, query: { key: token } }]);
    const echoed = `GET /x?key=${encodeURIComponent(token)}`;
    expect(echoed).not.toContain(token);
    expect(r(echoed)).toBe("GET /x?key=[REDACTED]");
    expect(injectionSecrets({ headers: {}, query: { key: token } })).toContain(
      encodeURIComponent(token),
    );
  });

  it("Credentials.injectionFor 把同一套展开（含编码形式）登记进 logger（≥ 12）", () => {
    const lines: string[] = [];
    const log = createLogger("info", { write: (l) => lines.push(l) });
    const creds = new Credentials(null as never, null as never, log);
    const token = "tok/with+special=chars&more";
    creds.injectionFor(
      "app1",
      { type: "api_key", ownership: "org", in: "query", name: "key" },
      {
        token,
      },
    );
    log.warn("upstream", { url: `https://x/?key=${encodeURIComponent(token)}`, raw: token });
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.join("\n")).not.toContain(encodeURIComponent(token));
    expect(lines.join("\n")).toContain("[REDACTED]");
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
