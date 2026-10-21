import type { Logger } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import type { KernelDb } from "../../../src/db/kernel-schema.js";
import type { PluginHost } from "../../../src/plugins/host.js";
import { parseGrepNull } from "../../../src/tools/builtins/sandbox/grep.js";
import {
  assignAttachmentNames,
  compileGlob,
  formatExec,
  GlobPatternError,
  MAX_GLOB_STARS,
  type SandboxToolDeps,
  sandboxTools,
  shellQuote,
} from "../../../src/tools/builtins/sandbox/index.js";
import type { Credentials } from "../../../src/tools/credentials.js";
import { BUILTIN_TOOL_NAMES, type BuiltinTool, ToolRegistry } from "../../../src/tools/registry.js";

/** M5 T8：沙箱工具的纯函数与「没有沙箱提供方」时的不可用说明。 */

describe("compileGlob", () => {
  it("** crosses directories, * does not", () => {
    const m = compileGlob("**/*.txt");
    expect(m("a.txt")).toBe(true);
    expect(m("src/deep/a.txt")).toBe(true);
    expect(m("a.md")).toBe(false);
    const flat = compileGlob("*.txt");
    expect(flat("a.txt")).toBe(true);
    expect(flat("src/a.txt")).toBe(false);
  });

  it("supports ?, braces and character classes; other characters are literal", () => {
    expect(compileGlob("?.{md,txt}")("a.md")).toBe(true);
    expect(compileGlob("?.{md,txt}")("ab.md")).toBe(false);
    expect(compileGlob("[ab].js")("b.js")).toBe(true);
    expect(compileGlob("[!ab].js")("b.js")).toBe(false);
    expect(compileGlob("[a-c]x")("bx")).toBe(true);
    expect(compileGlob("a+b(1).js")("a+b(1).js")).toBe(true);
    expect(compileGlob("src/**")("src/x/y")).toBe(true);
    expect(compileGlob("src/**/test/*.ts")("src/a/b/test/x.ts")).toBe(true);
    expect(compileGlob("src/**/test/*.ts")("src/test/x.ts")).toBe(true);
    expect(compileGlob("src/**/test/*.ts")("src/a/test/b/x.ts")).toBe(false);
    expect(compileGlob("{src,lib}/{a,b}/*.{js,ts}")("lib/b/x.ts")).toBe(true);
  });

  it("pathological patterns finish quickly (no exponential backtracking)", () => {
    const pattern = `${"*a".repeat(12)}b`;
    const m = compileGlob(pattern);
    const name = "a".repeat(40);
    const paths = Array.from({ length: 2000 }, (_, i) => `dir${i}/${name}`);
    const deep = `${"**/".repeat(10)}*${"*a".repeat(10)}b`;
    const md = compileGlob(deep);
    const t0 = performance.now();
    expect(m(name)).toBe(false);
    for (const p of paths) m(p);
    expect(md(`${"x/".repeat(30)}${name}`)).toBe(false);
    // 指数回溯时要几十秒；放宽到 CI 也稳的上限
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("rejects patterns with too many wildcards or alternatives", () => {
    expect(() => compileGlob("*a".repeat(MAX_GLOB_STARS + 1))).toThrow(GlobPatternError);
    expect(() => compileGlob("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}")).toThrow(GlobPatternError);
    // 连续的 * 合并为一个，不算超限
    expect(compileGlob("*".repeat(200))("anything")).toBe(true);
  });
});

describe("formatExec", () => {
  it("explains a command stopped without a timeout (exitCode null)", () => {
    const text = formatExec(
      { exitCode: null, stdout: "partial", stderr: "", truncated: false, timedOut: false },
      120,
    );
    expect(text).toContain("partial");
    expect(text).toContain("stopped before it finished");
    expect(text).not.toContain("exit code");
  });
});

describe("parseGrepNull", () => {
  it("parses NUL-separated file names, including names with newlines and colons", () => {
    const out = parseGrepNull(
      "./a.txt\u00002:hello\n./we:ird\nname\u00001:x:y\n./cut\u00003:no-newline",
      "/workspace",
    );
    expect(out).toEqual(["/workspace/a.txt:2:hello", "/workspace/we:ird\\nname:1:x:y"]);
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

  it("caps names at 200 UTF-8 bytes, keeping the extension (also with a de-dup suffix)", () => {
    const long = `${"报告".repeat(100)}.xlsx`;
    const names = assignAttachmentNames(
      [
        { id: "1", name: long },
        { id: "2", name: long },
      ],
      new Set(),
    );
    const a = names.get("1") as string;
    const b = names.get("2") as string;
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(b)).toBeLessThanOrEqual(200);
    expect(a.endsWith(".xlsx")).toBe(true);
    expect(b.endsWith("-2.xlsx")).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("\uFFFD");
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

describe("attachment sync", () => {
  /** 内存里的沙箱：只实现同步与 read 用到的原语。 */
  function memSandbox() {
    const files = new Map<string, Uint8Array>();
    const writes: string[] = [];
    const p = {
      readFile: async (_h: unknown, path: string) => {
        const d = files.get(path);
        return d === undefined ? null : { data: d, truncated: false };
      },
      writeFile: async (_h: unknown, path: string, data: Uint8Array) => {
        files.set(path, data);
        writes.push(path);
      },
      stat: async (_h: unknown, path: string) => {
        const d = files.get(path);
        return d === undefined ? null : { size: d.byteLength, isDir: false };
      },
    };
    const sandbox = {
      available: true,
      withSandbox: async (
        _ctx: unknown,
        fn: (h: unknown, p: unknown, info: unknown, s: AbortSignal) => Promise<unknown>,
      ) => fn({ id: "x" }, p, { fresh: false, recreated: false }, new AbortController().signal),
    };
    return { files, writes, sandbox };
  }

  it("one failing attachment is skipped with a notice; progress is saved after each file", async () => {
    const mem = memSandbox();
    const body = (t: string) => new Response(t).body as ReadableStream<Uint8Array>;
    const attachments = {
      listForConversation: async () => [
        { id: "a1", name: "broken.csv" },
        { id: "a2", name: "ok.csv" },
      ],
      openForConversation: async (_o: string, _c: string, id: string) => {
        if (id === "a1") throw new Error("connect ECONNREFUSED 10.0.0.5:8333");
        return { name: "ok.csv", contentType: "text/csv", size: 2, body: body("ok") };
      },
    };
    const read = sandboxTools({
      // biome-ignore lint/suspicious/noExplicitAny: 测试替身
      sandbox: mem.sandbox as any,
      // biome-ignore lint/suspicious/noExplicitAny: 测试替身
      attachments: attachments as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      eventLog: {} as any,
      config: () =>
        KernelConfigSchema.parse({
          db: { url: "postgres://x/y" },
          redis: { url: "redis://x" },
          masterKey: Buffer.alloc(32, 7).toString("base64"),
        }),
    }).find((t) => t.spec.name === "sandbox_read");
    mem.files.set("/workspace/f.txt", new TextEncoder().encode("hello\n"));
    const r = (await read?.run(
      { path: "/workspace/f.txt" },
      {
        orgId: "o",
        accountId: "a",
        agentId: "g",
        conversationId: "c",
        callId: "call",
        signal: new AbortController().signal,
      },
    )) as { content: { text: string }[] };
    const text = r.content[0]?.text ?? "";
    expect(text).toContain("Attachment broken.csv could not be copied");
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).toContain("/workspace/attachments/ok.csv");
    expect(text).toContain("hello");
    // 复制完 ok.csv 后立即写了标记文件
    expect(mem.writes).toEqual([
      "/workspace/attachments/ok.csv",
      "/workspace/attachments/.capybara-sync.json",
    ]);
    const marker = JSON.parse(
      new TextDecoder().decode(mem.files.get("/workspace/attachments/.capybara-sync.json")),
    );
    expect(marker).toEqual({ a2: "ok.csv" });
  });
});

describe("fix round 2: sync marker, deliver failures, grep exit 2", () => {
  const cfg = KernelConfigSchema.parse({
    db: { url: "postgres://x/y" },
    redis: { url: "redis://x" },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const callCtx = () => ({
    orgId: "00000000-0000-4000-8000-000000000001",
    accountId: "a",
    agentId: "g",
    conversationId: "c",
    callId: "call",
    runId: "run",
    signal: new AbortController().signal,
  });

  /** 可定制的内存沙箱：`failWrite` 让指定路径的写入失败，`exec` 返回固定结果。 */
  function rig(
    opts: {
      attachments?: { id: string; name: string }[];
      failWrite?: string;
      exec?: { exitCode: number; stdout: string; stderr: string };
      append?: () => Promise<unknown>;
    } = {},
  ) {
    const files = new Map<string, Uint8Array>();
    const puts: string[] = [];
    const deletes: string[] = [];
    const p = {
      readFile: async (_h: unknown, path: string) => {
        const d = files.get(path);
        return d === undefined ? null : { data: d, truncated: false };
      },
      writeFile: async (_h: unknown, path: string, data: Uint8Array) => {
        if (path === opts.failWrite) throw new Error("disk full");
        files.set(path, data);
      },
      stat: async (_h: unknown, path: string) => {
        if (path === "/workspace") return { size: 0, isDir: true };
        const d = files.get(path);
        return d === undefined ? null : { size: d.byteLength, isDir: false };
      },
      exec: async () => ({ ...opts.exec, truncated: false, timedOut: false }),
    };
    const tools = sandboxTools({
      sandbox: {
        available: true,
        withSandbox: async (
          _ctx: unknown,
          fn: (h: unknown, p: unknown, info: unknown, s: AbortSignal) => Promise<unknown>,
        ) => fn({ id: "x" }, p, { fresh: false, recreated: false }, new AbortController().signal),
      } as unknown as SandboxToolDeps["sandbox"],
      attachments: {
        listForConversation: async () => opts.attachments ?? [],
        openForConversation: async () => ({
          name: "f",
          contentType: "text/plain",
          size: 2,
          body: new Response("ok").body,
        }),
      } as unknown as SandboxToolDeps["attachments"],
      storage: {
        kernel: () => ({
          put: async (key: string) => {
            puts.push(key);
            return { key, size: 0 };
          },
          delete: async (key: string) => {
            deletes.push(key);
          },
        }),
      } as unknown as SandboxToolDeps["storage"],
      eventLog: {
        append: opts.append ?? (async () => []),
      } as unknown as SandboxToolDeps["eventLog"],
      config: () => cfg,
    });
    const tool = (name: string) => tools.find((t) => t.spec.name === name) as BuiltinTool;
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
    return { files, puts, deletes, tool, text };
  }

  it("a failed marker write still counts the file as copied; the marker keeps only saved entries", async () => {
    const r = rig({
      attachments: [{ id: "a1", name: "ok.csv" }],
      failWrite: "/workspace/attachments/.capybara-sync.json",
    });
    r.files.set("/workspace/f.txt", new TextEncoder().encode("hi\n"));
    const out = r.text(await r.tool("sandbox_read").run({ path: "/workspace/f.txt" }, callCtx()));
    expect(out).toContain("Attachments copied into the sandbox: /workspace/attachments/ok.csv");
    expect(out).not.toContain("could not be copied");
    expect(r.files.has("/workspace/attachments/.capybara-sync.json")).toBe(false);
  });

  it("deliver rejects a bad name before reading or uploading anything", async () => {
    const r = rig();
    r.files.set("/workspace/out.txt", new TextEncoder().encode("x"));
    await expect(
      r
        .tool("sandbox_deliver")
        .run({ path: "/workspace/out.txt", name: "bad\u0001name" }, callCtx()),
    ).rejects.toThrow(/control characters/);
    await expect(
      r
        .tool("sandbox_deliver")
        .run({ path: "/workspace/out.txt", name: "x".repeat(300) }, callCtx()),
    ).rejects.toThrow(/plain file name/);
    expect(r.puts).toEqual([]);
  });

  it("deliver deletes the uploaded object when writing artifact_created fails", async () => {
    const r = rig({
      append: async () => {
        throw new Error("db down");
      },
    });
    r.files.set("/workspace/out.txt", new TextEncoder().encode("x"));
    await expect(
      r.tool("sandbox_deliver").run({ path: "/workspace/out.txt" }, callCtx()),
    ).rejects.toThrow("db down");
    expect(r.puts).toHaveLength(1);
    expect(r.deletes).toEqual(r.puts);
  });

  it("grep exit 2 with partial matches returns them with the error note", async () => {
    const r = rig({
      exec: {
        exitCode: 2,
        stdout: "./a.txt\u00001:hit\n",
        stderr: "grep: ./secret: Permission denied",
      },
    });
    const out = r.text(await r.tool("sandbox_grep").run({ pattern: "hit" }, callCtx()));
    expect(out).toContain("/workspace/a.txt:1:hit");
    expect(out).toContain("[grep also reported errors: grep: ./secret: Permission denied]");
  });

  it("grep exit 2 whose only output is the hidden marker returns no matches plus the note", async () => {
    const r = rig({
      exec: {
        exitCode: 2,
        stdout: './attachments/.capybara-sync.json\u00001:{"a":"hit"}\n',
        stderr: "grep: ./secret: Permission denied",
      },
    });
    const out = r.text(await r.tool("sandbox_grep").run({ pattern: "hit" }, callCtx()));
    expect(out).toContain("No matches for hit in /workspace.");
    expect(out).toContain("[grep also reported errors:");
    expect(out).not.toContain(".capybara-sync.json");
  });

  it("glob shows newlines in file names as \\n", async () => {
    const r = rig({
      exec: { exitCode: 0, stdout: "./we\nird.txt\u0000./b.txt\u0000", stderr: "" },
    });
    const out = r.text(await r.tool("sandbox_glob").run({ pattern: "*.txt" }, callCtx()));
    expect(out.split("\n")).toEqual(["/workspace/b.txt", "/workspace/we\\nird.txt"]);
  });
});
