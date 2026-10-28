import { secret } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { secretValues } from "../src/config/fields.js";
import { createLogger } from "../src/log.js";

function capture(level: string) {
  const lines: string[] = [];
  const logger = createLogger(level, { write: (l) => lines.push(l) });
  return { logger, lines };
}

describe("createLogger", () => {
  it("one JSON line per record: time / level / msg / fields", () => {
    const { logger, lines } = capture("info");
    logger.info("hello", { a: 1 });
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0] as string);
    expect(e).toMatchObject({ level: "info", msg: "hello", a: 1 });
    expect(e.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(e).not.toHaveProperty("ts");
    expect(e).not.toHaveProperty("pid");
    expect(e).not.toHaveProperty("hostname");
  });

  it("按级别过滤，setLevel 生效，非法级别被拒绝", () => {
    const { logger, lines } = capture("warn");
    logger.info("drop");
    logger.debug("drop");
    logger.warn("keep");
    logger.setLevel("debug");
    logger.debug("keep2");
    expect(logger.level).toBe("debug");
    expect(() => logger.setLevel("loud")).toThrow(/log level/);
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["keep", "keep2"]);
  });

  it("fields cannot overwrite time / level / msg; an Error is serialized", () => {
    const { logger, lines } = capture("info");
    logger.error("x", { level: "debug", msg: "y", time: "then", err: new Error("bad") });
    const line = lines[0] as string;
    const e = JSON.parse(line);
    expect(e.level).toBe("error");
    expect(e.msg).toBe("x");
    expect(e.time).not.toBe("then");
    expect(line.match(/"time"/g)).toHaveLength(1);
    expect(line.match(/"level"/g)).toHaveLength(1);
    expect(line.match(/"msg"/g)).toHaveLength(1);
    expect(e.err).toEqual({ name: "Error", message: "bad", stack: expect.any(String) });
  });

  it("base fields (role) are on every record and cannot be overwritten", () => {
    const lines: string[] = [];
    const logger = createLogger("info", { write: (l) => lines.push(l), base: { role: "api" } });
    logger.info("x", { role: "worker", a: 1 });
    const line = lines[0] as string;
    expect(JSON.parse(line)).toMatchObject({ role: "api", a: 1, msg: "x" });
    expect(line.match(/"role"/g)).toHaveLength(1);
  });

  it("deep nesting and long arrays are kept whole", () => {
    const { logger, lines } = capture("info");
    let deep: Record<string, unknown> = { leaf: "bottom" };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    logger.info("x", { deep, list: Array.from({ length: 300 }, (_, i) => i) });
    const e = JSON.parse(lines[0] as string);
    expect(lines[0]).toContain('"leaf":"bottom"');
    expect(e.list).toHaveLength(300);
  });

  it("登记的密钥值在消息、字段与错误里都被打码（含同一凭据换了 host 的 URL）", () => {
    const { logger, lines } = capture("info");
    logger.addSecrets(["postgres://u:s3cretpw@db:5432/x"]);
    logger.info("connect postgres://u:s3cretpw@db:5432/x failed", {
      nested: { url: "postgres://u:s3cretpw@db:5432/x" },
      err: new Error("cannot reach postgres://u:s3cretpw@other-host/y"),
    });
    expect(lines[0]).not.toContain("s3cretpw");
    expect(lines[0]).toContain("[REDACTED]");
  });

  it("不单独打码裸密码，避免误伤与密码同名的普通字段", () => {
    const { logger, lines } = capture("info");
    logger.addSecrets(["postgres://capybara:capybara@localhost/capybara"]);
    logger.info("migrations applied", { schema: "capybara" });
    expect(JSON.parse(lines[0] as string).schema).toBe("capybara");
  });

  it("数字密钥（≥ 4 位）转成字符串后打码，数字字段同样打码；3 位数字不登记", () => {
    const { logger, lines } = capture("info");
    logger.addSecrets([12345678, 98765n, 443]);
    logger.info("x", { text: "pin 12345678 code 98765 port 443", pin: 12345678, port: 443 });
    const e = JSON.parse(lines[0] as string);
    expect(e.text).toBe("pin [REDACTED] code [REDACTED] port 443");
    expect(e.pin).toBe("[REDACTED]");
    expect(e.port).toBe(443);
  });

  it("布尔密钥不登记：日志里的 true / false 保持原样", () => {
    const { logger, lines } = capture("info");
    logger.addSecrets([true, false]);
    logger.addSecrets(secretValues(z.object({ flag: secret(z.boolean()) }), { flag: true }));
    logger.info("x", { text: "enabled=true cached=false", ok: true });
    const e = JSON.parse(lines[0] as string);
    expect(e.text).toBe("enabled=true cached=false");
    expect(e.ok).toBe(true);
  });

  it("顶层 level 从不打码；部署方密钥在 msg 与字段里都打码", () => {
    const { logger, lines } = capture("info");
    logger.addSecrets(["info", "hello-secret"]);
    logger.info("hello-secret here", { detail: "hello-secret", nested: { msg: "hello-secret" } });
    const e = JSON.parse(lines[0] as string);
    expect(e.level).toBe("info");
    expect(e.msg).toBe("[REDACTED] here");
    expect(e.detail).toBe("[REDACTED]");
    expect(e.nested.msg).toBe("[REDACTED]");
  });

  it("组织来源密钥不动顶层 msg，同一个值在其他字段里打码", () => {
    const { logger, lines } = capture("info");
    logger.addOrgSecrets(["tenant-chosen-value-01"]);
    logger.info("got tenant-chosen-value-01", {
      detail: "tenant-chosen-value-01",
      nested: { msg: "tenant-chosen-value-01" },
    });
    const e = JSON.parse(lines[0] as string);
    expect(e.msg).toBe("got tenant-chosen-value-01");
    expect(e.detail).toBe("[REDACTED]");
    expect(e.nested.msg).toBe("[REDACTED]");
  });

  it("组织来源密钥：短于 12 个字符不登记，≥ 12 个字符登记", () => {
    const { logger, lines } = capture("info");
    logger.addOrgSecrets(["plugin", "8080", "abcd1234", "org-secret-123456"]);
    logger.info("x", { a: "plugin 8080 abcd1234", b: "org-secret-123456" });
    const e = JSON.parse(lines[0] as string);
    expect(e.a).toBe("plugin 8080 abcd1234");
    expect(e.b).toBe("[REDACTED]");
  });

  it("组织来源密钥集合有界：超出容量淘汰最早登记的（重复登记会刷新位置）", () => {
    const lines: string[] = [];
    const logger = createLogger("info", { write: (l) => lines.push(l), orgSecretCapacity: 2 });
    logger.addOrgSecrets(["first-secret-0001", "second-secret-002"]);
    logger.addOrgSecrets(["first-secret-0001"]); // 刷新：second 变成最早的
    logger.addOrgSecrets(["third-secret-00003"]);
    logger.info("x", { a: "first-secret-0001", b: "second-secret-002", c: "third-secret-00003" });
    const e = JSON.parse(lines[0] as string);
    expect(e).toMatchObject({ a: "[REDACTED]", b: "second-secret-002", c: "[REDACTED]" });
  });

  it("匹配器只在密钥集合变化后重建，不随日志行重建", () => {
    let builds = 0;
    const logger = createLogger("info", { write: () => {}, onMatcherBuild: () => builds++ });
    logger.addSecrets(["secret-one"]);
    for (let i = 0; i < 50; i++) logger.info("x", { a: "secret-one", b: "plain" });
    // 字段匹配器（全部密钥）与 msg 匹配器（部署方密钥）各一次
    expect(builds).toBe(2);
    logger.addSecrets(["secret-one"]); // 已登记：不变
    logger.info("x", { a: "y" });
    expect(builds).toBe(2);
    logger.addOrgSecrets(["org-secret-123456"]); // 只影响字段匹配器
    for (let i = 0; i < 50; i++) logger.info("x", { a: "z" });
    expect(builds).toBe(3);
  });

  it("性能：10000 个已登记密钥，1000 行 × 10 个字段在 500ms 内", () => {
    const logger = createLogger("info", { write: () => {} });
    logger.addSecrets(Array.from({ length: 5_000 }, (_, i) => `deploy-secret-${i}-${i * 7919}`));
    logger.addOrgSecrets(
      Array.from({ length: 5_000 }, (_, i) => `org-tenant-secret-${i}-${i * 104729}`),
    );
    const fields = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `f${i}`,
        `some ordinary log text value number ${i} deploy-secret-42-332598`,
      ]),
    );
    logger.info("warmup", fields);
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i++) logger.info("line", fields);
    // CI 机器负载高时放宽；逐个密钥扫描的退化在秒级以上，2000ms 仍能抓到
    expect(performance.now() - t0).toBeLessThan(process.env.CI ? 2_000 : 500);
  });

  it("嵌套的组织配置密钥（secret 对象下的 record / 数组 / 数字）被打码", () => {
    const orgSchema = z.object({
      appId: z.string(),
      auth: secret(
        z.object({
          headers: z.record(z.string(), z.string()),
          keys: z.array(z.object({ id: z.string(), pin: z.number() })),
        }),
      ),
    });
    const cfg = orgSchema.parse({
      appId: "app-visible",
      auth: {
        headers: { "x-api-key": "hdr-secret-value" },
        keys: [{ id: "key-id-secret", pin: 24681357 }],
      },
    });
    const { logger, lines } = capture("info");
    logger.addSecrets(secretValues(orgSchema, cfg));
    logger.info("cfg", { cfg });
    const line = lines[0] as string;
    for (const v of ["hdr-secret-value", "key-id-secret", "24681357"]) {
      expect(line).not.toContain(v);
    }
    expect(line).toContain("app-visible");
  });

  it.each([
    [["abcdef", "cdefghijklmn"], "abcdefghijklmn"],
    [["user=admin;", "admin;pw=Sup3rS3cretValue"], "user=admin;pw=Sup3rS3cretValue"],
    [["k1=aaaa-bb", "bb-cccc-dd", "dd-eeee-ff"], "x k1=aaaa-bb-cccc-dd-eeee-ff y"],
  ])("重叠的密钥 %j：任何密钥的字符都不残留", (secretList, text) => {
    const { logger, lines } = capture("info");
    logger.addSecrets(secretList);
    logger.info("x", { text, nested: { text } });
    const e = JSON.parse(lines[0] as string);
    for (const out of [e.text, e.nested.text] as string[]) {
      const rest = out.replaceAll("[REDACTED]", "\u0000");
      for (const sec of secretList) {
        // 密钥的任一 4 字符片段都不能出现在输出里
        for (let i = 0; i + 4 <= sec.length; i++) expect(rest).not.toContain(sec.slice(i, i + 4));
      }
    }
    expect(e.text).toBe(text.startsWith("x ") ? "x [REDACTED] y" : "[REDACTED]");
  });

  it("不重叠的两个密钥分别替换", () => {
    const { logger, lines } = capture("info");
    logger.addSecrets(["alpha-secret", "omega-secret"]);
    logger.info("x", { text: "a alpha-secret b omega-secret c" });
    expect(JSON.parse(lines[0] as string).text).toBe("a [REDACTED] b [REDACTED] c");
  });

  it("循环引用不抛错", () => {
    const { logger, lines } = capture("info");
    const o: Record<string, unknown> = {};
    o.self = o;
    logger.info("loop", { o });
    expect(JSON.parse(lines[0] as string).msg).toBe("loop");
  });
});

describe("redact（日志之外的文本打码）", () => {
  it("按部署方与组织来源的密钥打码；没有登记的文本原样返回", () => {
    const log = createLogger("info", { write: () => {} });
    log.addSecrets(["deploy-secret-1"]);
    log.addOrgSecrets(["org-secret-value-123"]);
    expect(
      log.redact("connect failed: token deploy-secret-1 / org-secret-value-123 rejected"),
    ).toBe("connect failed: token [REDACTED] / [REDACTED] rejected");
    expect(log.redact("nothing to hide")).toBe("nothing to hide");
  });
});

describe("console format", () => {
  function sink() {
    const chunks: string[] = [];
    return {
      chunks,
      out: {
        write(s: string) {
          chunks.push(s);
          return true;
        },
      },
    };
  }

  it("json writes one JSON line per record to the console stream", () => {
    const { chunks, out } = sink();
    const logger = createLogger("info", { format: "json", out, isTTY: true });
    logger.info("hello", { a: 1 });
    expect(chunks.join("")).toMatch(/^\{.*"msg":"hello".*\}\n$/);
  });

  it("auto picks json when the console is not a TTY", () => {
    const { chunks, out } = sink();
    const logger = createLogger("info", { format: "auto", out, isTTY: false });
    logger.info("hello");
    expect(JSON.parse(chunks.join("")).msg).toBe("hello");
  });

  it("pretty without a TTY prints one line per record with level, prefix and msg, no colors", () => {
    const { chunks, out } = sink();
    const logger = createLogger("debug", {
      format: "pretty",
      out,
      isTTY: false,
      base: { role: "api,worker" },
    });
    logger.addSecrets(["pretty-secret-1"]);
    logger.warn("disk pretty-secret-1 low", { free: 3, nested: { a: "b" } });
    logger.debug("second");
    const text = chunks.join("");
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] WARN/);
    expect(lines[0]).toContain("[api,worker] disk [REDACTED] low");
    expect(lines[0]).toContain('"free":3');
    expect(lines[1]).toContain("DEBUG");
    expect(text).not.toContain("pretty-secret-1");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for ANSI escapes
    expect(text).not.toMatch(/\u001b\[/);
  });

  it("pretty in a TTY uses colors", () => {
    const { chunks, out } = sink();
    const logger = createLogger("info", { format: "pretty", out, isTTY: true });
    logger.error("boom");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for ANSI escapes
    expect(chunks.join("")).toMatch(/\u001b\[/);
  });

  it("an unknown format is refused", () => {
    expect(() => createLogger("info", { format: "loud" as never })).toThrow(/log\.format/);
  });
});
