import { describe, expect, it } from "vitest";
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

  it("循环引用不抛错", () => {
    const { logger, lines } = capture("info");
    const o: Record<string, unknown> = {};
    o.self = o;
    logger.info("loop", { o });
    expect(JSON.parse(lines[0] as string).msg).toBe("loop");
  });
});
