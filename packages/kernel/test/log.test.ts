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
  it("每条一行 JSON：ts / level / msg / 字段", () => {
    const { logger, lines } = capture("info");
    logger.info("hello", { a: 1 });
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0] as string);
    expect(e).toMatchObject({ level: "info", msg: "hello", a: 1 });
    expect(typeof e.ts).toBe("string");
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

  it("字段不能覆盖 ts / level / msg；Error 被序列化", () => {
    const { logger, lines } = capture("info");
    logger.error("x", { level: "debug", msg: "y", err: new Error("bad") });
    const e = JSON.parse(lines[0] as string);
    expect(e.level).toBe("error");
    expect(e.msg).toBe("x");
    expect(e.err).toMatchObject({ name: "Error", message: "bad" });
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

  it("非字符串密钥值（数字、布尔）转成字符串后打码，数字字段同样打码", () => {
    const { logger, lines } = capture("info");
    logger.addSecrets([12345678, 98765n]);
    logger.info("pin 12345678 code 98765", { pin: 12345678, other: 42 });
    const e = JSON.parse(lines[0] as string);
    expect(lines[0]).not.toContain("12345678");
    expect(lines[0]).not.toContain("98765");
    expect(e.pin).toBe("[REDACTED]");
    expect(e.other).toBe(42);
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

  it("循环引用不抛错", () => {
    const { logger, lines } = capture("info");
    const o: Record<string, unknown> = {};
    o.self = o;
    logger.info("loop", { o });
    expect(JSON.parse(lines[0] as string).msg).toBe("loop");
  });
});
