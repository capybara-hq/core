import type { Logger } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import type { KernelDb } from "../../../src/db/kernel-schema.js";
import type { PluginHost } from "../../../src/plugins/host.js";
import {
  assignAttachmentNames,
  globToRegExp,
  sandboxTools,
  shellQuote,
} from "../../../src/tools/builtins/sandbox/index.js";
import type { Credentials } from "../../../src/tools/credentials.js";
import { BUILTIN_TOOL_NAMES, ToolRegistry } from "../../../src/tools/registry.js";

/** M5 T8：沙箱工具的纯函数与「没有沙箱提供方」时的不可用说明。 */

describe("globToRegExp", () => {
  it("** crosses directories, * does not", () => {
    const re = globToRegExp("**/*.txt");
    expect(re.test("a.txt")).toBe(true);
    expect(re.test("src/deep/a.txt")).toBe(true);
    expect(re.test("a.md")).toBe(false);
    const flat = globToRegExp("*.txt");
    expect(flat.test("a.txt")).toBe(true);
    expect(flat.test("src/a.txt")).toBe(false);
  });

  it("supports ?, braces and character classes; escapes regex characters", () => {
    expect(globToRegExp("?.{md,txt}").test("a.md")).toBe(true);
    expect(globToRegExp("?.{md,txt}").test("ab.md")).toBe(false);
    expect(globToRegExp("[ab].js").test("b.js")).toBe(true);
    expect(globToRegExp("a+b(1).js").test("a+b(1).js")).toBe(true);
    expect(globToRegExp("src/**").test("src/x/y")).toBe(true);
  });
});

describe("assignAttachmentNames", () => {
  it("sanitizes names into single safe path segments and de-duplicates", () => {
    const names = assignAttachmentNames(
      [
        { id: "1", name: "report.csv" },
        { id: "2", name: "report.csv" },
        { id: "3", name: "a/b\\c.txt" },
        { id: "4", name: ".." },
        { id: "5", name: "bad\u0001name.txt" },
      ],
      new Set(["report-2.csv"]),
    );
    expect(names.get("1")).toBe("report.csv");
    expect(names.get("2")).toBe("report-3.csv");
    expect(names.get("3")).toBe("a_b_c.txt");
    expect(names.get("4")).toBe("attachment");
    expect(names.get("5")).toBe("bad_name.txt");
  });
});

describe("sandbox_bash time limit", () => {
  it("covers the command timeout plus the lock / create margin, capped by maxCommandSeconds", () => {
    const cfg = KernelConfigSchema.parse({
      db: { url: "postgres://x/y" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
    });
    const bash = sandboxTools({
      // biome-ignore lint/suspicious/noExplicitAny: 只用到配置
      sandbox: { available: true } as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      attachments: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      eventLog: {} as any,
      config: () => cfg,
    }).find((t) => t.spec.name === "sandbox_bash");
    const margin = cfg.tools.timeoutMs + cfg.sandbox.lockWaitSeconds * 1000;
    expect(bash?.spillChars).toBe(30_000);
    expect(bash?.timeoutMs?.({ command: "x", timeoutSeconds: 600 })).toBe(600_000 + margin);
    expect(bash?.timeoutMs?.({ command: "x" })).toBe(120_000 + margin);
    expect(bash?.timeoutMs?.({ command: "x", timeoutSeconds: 99_999 })).toBe(7_200_000 + margin);
  });
});

describe("shellQuote", () => {
  it("single-quotes and escapes embedded quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("registry without a sandbox provider", () => {
  it("sandbox tools are built-in names and resolve as unavailable with an actionable reason", async () => {
    for (const t of [
      "sandbox_bash",
      "sandbox_read",
      "sandbox_write",
      "sandbox_edit",
      "sandbox_glob",
      "sandbox_grep",
      "sandbox_deliver",
    ]) {
      expect(BUILTIN_TOOL_NAMES as readonly string[]).toContain(t);
    }
    const tools = sandboxTools({
      // biome-ignore lint/suspicious/noExplicitAny: 只用到 available
      sandbox: { available: false } as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      attachments: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      eventLog: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      config: () => ({}) as any,
    });
    expect(tools.map((t) => t.spec.name)).toHaveLength(7);
    const registry = new ToolRegistry({
      db: {} as KernelDb,
      host: { tools: () => [], list: () => [] } as unknown as PluginHost,
      credentials: {} as Credentials,
      log: {} as Logger,
      builtins: tools,
    });
    const got = await registry.forAgent("org", {
      tools: [{ kind: "builtin", name: "sandbox_bash" }],
    });
    expect(got.tools).toEqual([]);
    expect(got.unavailable).toHaveLength(1);
    expect(got.unavailable[0]?.ref).toBe("sandbox_bash");
    expect(got.unavailable[0]?.reason).toMatch(/sandbox/i);
    expect(got.unavailable[0]?.reason).toMatch(/administrator/);
  });
});
