import { EventEmitter } from "node:events";
import { secret } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { secretValues } from "../src/config/fields.js";
import { createLogger, type KernelLogger } from "../src/log.js";

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

  it("redaction cost does not grow with the number of registered secrets (10000 vs 1)", () => {
    // Compares two loggers in the same process and conditions instead of a wall-clock budget: a
    // loaded machine slows both alike, while a per-secret scan would make the 10000-secret logger
    // hundreds of times slower than the one-secret logger. Interleaved rounds, best of each.
    const fields = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `f${i}`,
        `some ordinary log text value number ${i} deploy-secret-42-332598`,
      ]),
    );
    const many = createLogger("info", { write: () => {} });
    many.addSecrets(Array.from({ length: 5_000 }, (_, i) => `deploy-secret-${i}-${i * 7919}`));
    many.addOrgSecrets(
      Array.from({ length: 5_000 }, (_, i) => `org-tenant-secret-${i}-${i * 104729}`),
    );
    const one = createLogger("info", { write: () => {} });
    one.addSecrets(["deploy-secret-42-332598"]);
    const time = (logger: KernelLogger) => {
      const t0 = performance.now();
      for (let i = 0; i < 1_000; i++) logger.info("line", fields);
      return performance.now() - t0;
    };
    time(many); // warmup and matcher build
    time(one);
    let best = { many: Number.POSITIVE_INFINITY, one: Number.POSITIVE_INFINITY };
    for (let round = 0; round < 5; round++) {
      best = { many: Math.min(best.many, time(many)), one: Math.min(best.one, time(one)) };
    }
    expect(best.many).toBeLessThan(best.one * 20);
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

  it("pretty follows the octok layout: full time, level, [pid] - [context] msg, fields below", () => {
    const { chunks, out } = sink();
    const logger = createLogger("debug", {
      format: "pretty",
      out,
      isTTY: false,
      colors: false,
      base: { role: "api,worker" },
    });
    logger.addSecrets(["pretty-secret-1"]);
    logger.child({ context: "DiskWatch" }).warn("disk pretty-secret-1 low", { free: 3 });
    logger.debug("second");
    const text = chunks.join("");
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}\] WARN: \[pid=\d+\] - \[context=DiskWatch\] disk \[REDACTED\] low$/,
    );
    // the remaining fields are indented key: value lines, not trailing JSON
    expect(lines[1]).toMatch(/^\s+free: 3$/);
    expect(lines[2]).toContain("DEBUG: [pid=");
    expect(text).not.toContain("api,worker");
    expect(text).not.toContain("pretty-secret-1");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for ANSI escapes
    expect(text).not.toMatch(/\u001b\[/);
  });

  it("pretty prefix order: traceId, reqId, queue, jobId, runId, context, plugin", () => {
    const { chunks, out } = sink();
    const logger = createLogger("info", { format: "pretty", out, colors: false });
    logger.info("m", {
      plugin: "p",
      context: "C",
      runId: "r",
      jobId: "j",
      queue: "q",
      reqId: "rq",
      traceId: "t",
    });
    expect(chunks.join("")).toContain(
      "- [traceId=t] [reqId=rq] [queue=q] [jobId=j] [runId=r] [context=C] [plugin=p] m",
    );
  });

  it("pretty folds the HTTP access record into one sentence", () => {
    const { chunks, out } = sink();
    const logger = createLogger("info", { format: "pretty", out, colors: false });
    logger.info("request", { method: "GET", url: "/api/v1/me", status: 401, ms: 2, reqId: "x" });
    const text = chunks.join("");
    expect(text).toContain("[reqId=x] GET /api/v1/me 401 2ms");
    expect(text.trimEnd().split("\n")).toHaveLength(1);
  });

  it("pretty prints an error's stack below the message", () => {
    const { chunks, out } = sink();
    const logger = createLogger("info", { format: "pretty", out, colors: false });
    logger.error("boom", { err: new Error("kaput") });
    const text = chunks.join("");
    expect(text).toContain("kaput");
    expect(text).toMatch(/\n\s+at /);
  });

  it("pretty uses colors in a TTY, when forced, and not with NO_COLOR", () => {
    const run = (o: { isTTY?: boolean; colors?: boolean }) => {
      const { chunks, out } = sink();
      createLogger("info", { format: "pretty", out, ...o }).error("boom");
      return chunks.join("");
    };
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for ANSI escapes
    const ansi = /\u001b\[/;
    const saved = { force: process.env.FORCE_COLOR, no: process.env.NO_COLOR };
    try {
      delete process.env.FORCE_COLOR;
      delete process.env.NO_COLOR;
      expect(run({ isTTY: true })).toMatch(ansi);
      expect(run({ isTTY: false })).not.toMatch(ansi);
      process.env.FORCE_COLOR = "1";
      expect(run({ isTTY: false })).toMatch(ansi);
      process.env.FORCE_COLOR = "0";
      process.env.NO_COLOR = "1";
      expect(run({ isTTY: true })).not.toMatch(ansi);
      expect(run({ isTTY: false, colors: true })).toMatch(ansi);
    } finally {
      for (const [k, v] of [
        ["FORCE_COLOR", saved.force],
        ["NO_COLOR", saved.no],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("a console whose reader is gone (EPIPE) is no longer written to, and its error is handled", () => {
    // Without a listener the stream's error would be an uncaught exception (see process-guards).
    for (const format of ["json", "pretty"] as const) {
      const out = Object.assign(new EventEmitter(), {
        writes: 0,
        write: () => (out.writes++, true),
      });
      const logger = createLogger("info", { format, out, colors: false });
      logger.info("before");
      expect(out.writes).toBe(1);
      expect(out.listenerCount("error")).toBe(1);
      expect(() =>
        out.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
      ).not.toThrow();
      logger.info("after");
      logger.error("still after");
      expect(out.writes).toBe(1);
    }
  });

  it("an unknown format is refused", () => {
    expect(() => createLogger("info", { format: "loud" as never })).toThrow(/log\.format/);
  });
});

describe("child", () => {
  it("adds its fields to every record; call fields cannot overwrite them", () => {
    const { logger, lines } = capture("info");
    const child = logger.child({ context: "A" });
    child.info("x", { context: "B", a: 1 });
    child.child({ plugin: "p" }).warn("y");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ msg: "x", context: "A", a: 1 });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ msg: "y", context: "A", plugin: "p" });
  });

  it("shares level and secrets with its parent", () => {
    const { logger, lines } = capture("info");
    const child = logger.child({ context: "A" });
    child.setLevel("warn");
    expect(logger.level).toBe("warn");
    logger.info("dropped");
    logger.setLevel("info");
    expect(child.level).toBe("info");
    child.addSecrets(["child-secret-1"]);
    logger.info("a child-secret-1 b");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("a [REDACTED] b");
  });
});
