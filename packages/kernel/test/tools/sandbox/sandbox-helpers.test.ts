import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { startedText, taskOutputFile } from "../../../src/background/launch.js";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import type { ExtensionHost } from "../../../src/extensions/host.js";
import type { KernelDb } from "../../../src/infra/database/kernel-db.js";
import { syncMarkerMatcher } from "../../../src/tools/builtins/sandbox/common.js";
import { parseGrepNull } from "../../../src/tools/builtins/sandbox/grep.js";
import {
  assignAttachmentNames,
  compileGlob,
  formatExec,
  GlobPatternError,
  MAX_GLOB_STARS,
  SANDBOX_SETUP_MARGIN_MS,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  sandboxTools,
  searchTimeoutMs,
  shellQuote,
} from "../../../src/tools/builtins/sandbox/index.js";
import { skillLoadTool } from "../../../src/tools/builtins/skill-load.js";
import { BUILTIN_TOOL_NAMES, type BuiltinTool, ToolRegistry } from "../../../src/tools/registry.js";
import { noRowsDb, onlyBuiltins } from "../../helpers/disabled-tools.js";

/** M5 T8：沙箱工具的纯函数与「没有沙箱提供方」时的不可用说明。 */

/** Every call's conversation is bound to one device. */
const devices = { forTool: async () => "env-1" };

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

  it("a timed-out command is not told to rely on background work surviving", () => {
    const text = formatExec(
      { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: true },
      120,
    );
    expect(text).toContain("did not finish within 120s");
    expect(text).not.toMatch(/background/i);
    expect(text).toContain("/workspace");
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

describe("Bash time limit", () => {
  it("covers the command timeout plus the lock / create margin, capped by maxCommandSeconds", () => {
    const cfg = KernelConfigSchema.parse({
      db: { url: "postgres://x/y" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
    });
    const bash = sandboxTools({
      devices,
      // biome-ignore lint/suspicious/noExplicitAny: 只用到配置
      sandbox: { cloudAvailable: true } as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      attachments: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      eventLog: {} as any,
      config: { get: () => cfg },
    }).find((t) => t.spec.name === "Bash");
    // 等锁 + 创建 / 恢复 + 停命令的兜底（E2B 重启沙箱约 160 秒）
    const margin =
      cfg.tools.timeoutMs + cfg.sandbox.lockWaitSeconds * 1000 + SANDBOX_SETUP_MARGIN_MS;
    expect(SANDBOX_SETUP_MARGIN_MS).toBeGreaterThanOrEqual(160_000);
    expect(sandboxBaseTimeoutMs(cfg)).toBe(margin);
    expect(bash?.spillChars).toBe(30_000);
    expect(bash?.timeoutMs?.({ command: "x", timeout: 600_000 })).toBe(600_000 + margin);
    expect(bash?.timeoutMs?.({ command: "x" })).toBe(120_000 + margin);
    expect(bash?.timeoutMs?.({ command: "x", timeout: 99_999_000 })).toBe(7_200_000 + margin);
  });
});

describe("glob / grep command timeout (fix wave S2 minor 2)", () => {
  const cfg = KernelConfigSchema.parse({
    db: { url: "postgres://x/y" },
    redis: { url: "redis://x" },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });

  it("searchTimeoutMs: tools.timeoutMs while the call is young, shrinking after a long lock wait", () => {
    const t0 = 1_000_000;
    const wait = cfg.sandbox.lockWaitSeconds * 1000;
    expect(searchTimeoutMs(cfg, t0, t0)).toBe(cfg.tools.timeoutMs);
    expect(searchTimeoutMs(cfg, t0, t0 + wait)).toBe(cfg.tools.timeoutMs);
    expect(searchTimeoutMs(cfg, t0, t0 + wait + 20_000)).toBe(cfg.tools.timeoutMs - 20_000);
    expect(searchTimeoutMs(cfg, t0, t0 + 10 * wait)).toBe(1000);
    // 命令超时之后还留着停命令兜底的余量
    expect(
      t0 + wait + 20_000 + searchTimeoutMs(cfg, t0, t0 + wait + 20_000) + SANDBOX_SETUP_MARGIN_MS,
    ).toBe(t0 + sandboxBaseTimeoutMs(cfg));
  });

  it.each([
    ["Glob", { pattern: "*.txt" }],
    ["Grep", { pattern: "x" }],
  ])("%s passes the time left in the call to exec", async (name, input) => {
    let now = 5_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const timeouts: number[] = [];
      const p = {
        stat: async () => ({ size: 0, isDir: true }),
        exec: async (_h: unknown, a: { timeoutMs: number }) => {
          timeouts.push(a.timeoutMs);
          return {
            exitCode: name === "Grep" ? 1 : 0,
            stdout: "",
            stderr: "",
            truncated: false,
            timedOut: false,
          };
        },
      };
      const tool = sandboxTools({
        devices,
        sandbox: {
          cloudAvailable: true,
          availableFor: async () => true,
          // 等锁用掉了 lockWaitSeconds + 25 秒
          withSandbox: async (_c, fn, sig) => {
            now += cfg.sandbox.lockWaitSeconds * 1000 + 25_000;
            return fn(
              { id: "h" },
              p as never,
              { fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS },
              sig,
            );
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: 只列附件
        attachments: { listForConversation: async () => [] } as any,
        // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
        storage: {} as any,
        // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
        eventLog: {} as any,
        config: { get: () => cfg },
      }).find((t) => t.spec.name === name) as BuiltinTool;
      await tool.run(input, {
        orgId: "o",
        conversationId: "c",
        signal: AbortSignal.timeout(10_000),
        // biome-ignore lint/suspicious/noExplicitAny: 只用到上面几项
      } as any);
      expect(timeouts).toEqual([cfg.tools.timeoutMs - 25_000]);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("syncMarkerMatcher", () => {
  it("matches the marker file only, dots literal", () => {
    const isSyncMarkerEntry = syncMarkerMatcher();
    expect(isSyncMarkerEntry("/workspace/attachments/c/.capybara-sync.json")).toBe(true);
    expect(isSyncMarkerEntry("/workspace/attachments/c/.capybara-sync.json:1:x")).toBe(true);
    expect(isSyncMarkerEntry("/workspace/attachments/c/.capybara-syncXjson")).toBe(false);
    expect(isSyncMarkerEntry("/workspace/attachments/c/Xcapybara-sync.json")).toBe(false);
  });
});

describe("shellQuote", () => {
  it("single-quotes and escapes embedded quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("registry without a sandbox provider", () => {
  it("sandbox tools are built-in names and resolve as unavailable with an actionable reason", async () => {
    const names = [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Deliver",
      "TaskOutput",
      "TaskStop",
      "TaskList",
    ];
    for (const t of names) {
      expect(BUILTIN_TOOL_NAMES as readonly string[]).toContain(t);
    }
    const tools = sandboxTools({
      devices,
      // biome-ignore lint/suspicious/noExplicitAny: 只用到 cloudAvailable
      sandbox: { cloudAvailable: false } as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      attachments: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      eventLog: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      config: { get: () => ({}) as any },
    });
    expect(tools.map((t) => t.spec.name)).toEqual(names);
    const host = { tools: () => [], list: () => [] } as unknown as ExtensionHost;
    const registry = new ToolRegistry(
      noRowsDb() as KernelDb,
      host,
      host,
      { list: () => tools },
      {
        get: async () => ({ ok: true, config: {}, source: "platform" }),
      },
      { offKeys: async () => new Set() },
    );
    const got = await registry.forAgent("org", {
      source: "web",
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
    });
    expect(got.tools).toEqual([]);
    // never reported as unavailable (the agent did not ask for it): explained when named
    expect(got.unavailable).toEqual([]);
    expect(got.hidden).toHaveLength(1);
    expect(got.hidden?.[0]?.ref).toBe("Bash");
    expect(got.hidden?.[0]?.reason).toMatch(/sandbox/i);
    expect(got.hidden?.[0]?.reason).toMatch(/administrator/);
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
      cloudAvailable: true,
      availableFor: async () => true,
      withSandbox: async (
        _ctx: unknown,
        fn: (h: unknown, p: unknown, info: unknown, s: AbortSignal) => Promise<unknown>,
      ) =>
        fn(
          { id: "x" },
          p,
          { fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS },
          new AbortController().signal,
        ),
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
      devices,
      // biome-ignore lint/suspicious/noExplicitAny: 测试替身
      sandbox: mem.sandbox as any,
      // biome-ignore lint/suspicious/noExplicitAny: 测试替身
      attachments: attachments as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: 不会被调用
      eventLog: {} as any,
      config: {
        get: () =>
          KernelConfigSchema.parse({
            db: { url: "postgres://x/y" },
            redis: { url: "redis://x" },
            masterKey: Buffer.alloc(32, 7).toString("base64"),
          }),
      },
    }).find((t) => t.spec.name === "Read");
    mem.files.set("/workspace/f.txt", new TextEncoder().encode("hello\n"));
    const r = (await read?.run(
      { file_path: "/workspace/f.txt" },
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
    expect(text).toContain("/workspace/attachments/c/ok.csv");
    expect(text).toContain("hello");
    // 复制完 ok.csv 后立即写了标记文件
    expect(mem.writes).toEqual([
      "/workspace/attachments/c/ok.csv",
      "/workspace/attachments/c/.capybara-sync.json",
    ]);
    const marker = JSON.parse(
      new TextDecoder().decode(mem.files.get("/workspace/attachments/c/.capybara-sync.json")),
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
      /** 有没有对象存储（默认有）。 */
      storage?: boolean;
    } = {},
  ) {
    let reads = 0;
    const files = new Map<string, Uint8Array>();
    const puts: string[] = [];
    const deletes: string[] = [];
    const p = {
      readFile: async (_h: unknown, path: string) => {
        reads++;
        const d = files.get(path);
        return d === undefined ? null : { data: d, truncated: false };
      },
      writeFile: async (_h: unknown, path: string, data: Uint8Array) => {
        if (path === opts.failWrite) throw new Error("disk full");
        files.set(path, data);
      },
      stat: async (_h: unknown, path: string) => {
        reads++;
        if (path === "/workspace") return { size: 0, isDir: true };
        const d = files.get(path);
        return d === undefined ? null : { size: d.byteLength, isDir: false };
      },
      exec: async () => ({ ...opts.exec, truncated: false, timedOut: false }),
    };
    const tools = sandboxTools({
      devices,
      sandbox: {
        cloudAvailable: true,
        availableFor: async () => true,
        withSandbox: async (
          _ctx: unknown,
          fn: (h: unknown, p: unknown, info: unknown, s: AbortSignal) => Promise<unknown>,
        ) =>
          fn(
            { id: "x" },
            p,
            { fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS },
            new AbortController().signal,
          ),
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
        available: opts.storage ?? true,
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
      config: { get: () => cfg },
    });
    const tool = (name: string) => tools.find((t) => t.spec.name === name) as BuiltinTool;
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
    return { files, puts, deletes, tool, text, reads: () => reads };
  }

  it("a failed marker write still counts the file as copied; the marker keeps only saved entries", async () => {
    const r = rig({
      attachments: [{ id: "a1", name: "ok.csv" }],
      failWrite: "/workspace/attachments/c/.capybara-sync.json",
    });
    r.files.set("/workspace/f.txt", new TextEncoder().encode("hi\n"));
    const out = r.text(await r.tool("Read").run({ file_path: "/workspace/f.txt" }, callCtx()));
    expect(out).toContain("Attachments copied into the sandbox: /workspace/attachments/c/ok.csv");
    expect(out).not.toContain("could not be copied");
    expect(r.files.has("/workspace/attachments/c/.capybara-sync.json")).toBe(false);
  });

  it("deliver rejects a bad name before reading or uploading anything", async () => {
    const r = rig();
    r.files.set("/workspace/out.txt", new TextEncoder().encode("x"));
    await expect(
      r.tool("Deliver").run({ file_path: "/workspace/out.txt", name: "bad\u0001name" }, callCtx()),
    ).rejects.toThrow(/control characters/);
    await expect(
      r.tool("Deliver").run({ file_path: "/workspace/out.txt", name: "x".repeat(300) }, callCtx()),
    ).rejects.toThrow(/plain file name/);
    expect(r.puts).toEqual([]);
  });

  it("deliver: the description suggests tar -czf, not zip (the sandbox image has no zip)", () => {
    const d = rig().tool("Deliver").spec.description;
    expect(d).toContain("tar -czf");
    expect(d).not.toContain("zip");
  });

  it("deliver without an object store: unavailable with an English reason, fails before stat / read", async () => {
    const r = rig({ storage: false });
    r.files.set("/workspace/out.txt", new TextEncoder().encode("x"));
    const deliver = r.tool("Deliver");
    expect(await deliver.unavailable?.({ orgId: "o" })).toMatch(
      /^File storage is not configured in this deployment/,
    );
    // 其他沙箱工具不受影响
    expect(await r.tool("Read").unavailable?.({ orgId: "o" })).toBeNull();
    await expect(deliver.run({ file_path: "/workspace/out.txt" }, callCtx())).rejects.toThrow(
      /File storage is not configured/,
    );
    expect(r.reads()).toBe(0);
    expect(r.puts).toEqual([]);
    expect(await rig().tool("Deliver").unavailable?.({ orgId: "o" })).toBeNull();
  });

  it("deliver deletes the uploaded object when writing artifact_created fails", async () => {
    const r = rig({
      append: async () => {
        throw new Error("db down");
      },
    });
    r.files.set("/workspace/out.txt", new TextEncoder().encode("x"));
    await expect(
      r.tool("Deliver").run({ file_path: "/workspace/out.txt" }, callCtx()),
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
    const out = r.text(
      await r.tool("Grep").run({ pattern: "hit", output_mode: "content" }, callCtx()),
    );
    expect(out).toContain("/workspace/a.txt:1:hit");
    expect(out).toContain("[grep also reported errors: grep: ./secret: Permission denied]");
  });

  it("grep exit 2 whose only output is the hidden marker returns no matches plus the note", async () => {
    const r = rig({
      exec: {
        exitCode: 2,
        stdout: './attachments/c/.capybara-sync.json\u00001:{"a":"hit"}\n',
        stderr: "grep: ./secret: Permission denied",
      },
    });
    const out = r.text(
      await r.tool("Grep").run({ pattern: "hit", output_mode: "content" }, callCtx()),
    );
    expect(out).toContain("No matches for hit in /workspace.");
    expect(out).toContain("[grep also reported errors:");
    expect(out).not.toContain(".capybara-sync.json");
  });

  it("glob shows newlines in file names as \\n", async () => {
    const r = rig({
      exec: { exitCode: 0, stdout: "./we\nird.txt\u0000./b.txt\u0000", stderr: "" },
    });
    const out = r.text(await r.tool("Glob").run({ pattern: "*.txt" }, callCtx()));
    expect(out.split("\n")).toEqual(["/workspace/b.txt", "/workspace/we\\nird.txt"]);
  });
});

describe("read before write over Read's byte limit", () => {
  it("overwriting a file over 10 MB that the conversation itself just wrote succeeds", async () => {
    const files = new Map<string, Uint8Array>();
    const p = {
      readFile: async (_h: unknown, path: string, o: { maxBytes: number }) => {
        const d = files.get(path);
        if (d === undefined) return null;
        return { data: d.subarray(0, o.maxBytes), truncated: d.byteLength > o.maxBytes };
      },
      writeFile: async (_h: unknown, path: string, data: Uint8Array) => {
        files.set(path, data);
      },
      stat: async (_h: unknown, path: string) => {
        const d = files.get(path);
        return d === undefined ? null : { size: d.byteLength, isDir: false };
      },
    };
    // the log: the latest view.file of each path, as the conversation's tool_results record it
    const recorded = new Map<string, { size: number; sha256: string }>();
    const sandbox = {
      cloudAvailable: true,
      availableFor: async () => true,
      withSandbox: async (
        _ctx: unknown,
        fn: (h: unknown, p: unknown, info: unknown, s: AbortSignal) => Promise<unknown>,
      ) =>
        fn(
          { id: "x" },
          p,
          { fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS },
          new AbortController().signal,
        ),
    } as unknown as SandboxToolDeps["sandbox"];
    const tools = sandboxTools({
      devices,
      sandbox,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      attachments: { listForConversation: async () => [] } as any,
      // biome-ignore lint/suspicious/noExplicitAny: never called
      storage: {} as any,
      eventLog: {
        append: async () => [],
        latestFileState: async (_c: string, path: string) => recorded.get(path) ?? null,
      },
      config: {
        get: () =>
          KernelConfigSchema.parse({
            db: { url: "postgres://x/y" },
            redis: { url: "redis://x" },
            masterKey: Buffer.alloc(32, 7).toString("base64"),
          }),
      },
    });
    const write = tools.find((t) => t.spec.name === "Write") as BuiltinTool;
    const ctx = {
      orgId: "o",
      accountId: "a",
      agentId: "g",
      conversationId: "c",
      callId: "call",
      signal: new AbortController().signal,
    };
    const run = async (content: string) => {
      const r = (await write.run({ file_path: "/workspace/big.txt", content }, ctx)) as {
        view: { file: { path: string; size: number; sha256: string } };
      };
      const { path, ...state } = r.view.file;
      recorded.set(path, state);
      return r;
    };
    const first = await run("a".repeat(11_000_000));
    expect(first.view.file.size).toBe(11_000_000);
    const second = await run("small\n");
    expect(second.view.file.size).toBe(6);
  });
});

describe("custom roots (environments phase 2, spec §13.1)", () => {
  const ROOTS: SandboxRoots = {
    workspace: "/Users/u/capybara-device/e1/workspace",
    skills: "/Users/u/capybara-device/e1/skills",
    tmp: "/Users/u/capybara-device/e1/tmp",
  };
  const cfg = KernelConfigSchema.parse({
    db: { url: "postgres://x/y" },
    redis: { url: "redis://x" },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const ctx = {
    orgId: "o",
    accountId: "a",
    agentId: "g",
    conversationId: "0123abcd-4567-4890-8bcd-ef0123456789",
    callId: "call",
    runId: "run",
    signal: new AbortController().signal,
  };

  /** An instance whose handle carries `ROOTS`, with `attachments` waiting to be copied. */
  function device(attachments: { id: string; name: string }[] = []) {
    const files = new Map<string, Uint8Array>();
    const writes: string[] = [];
    const execs: { command: string; cwd: string }[] = [];
    const started: string[] = [];
    let entered = 0;
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
        if (path === ROOTS.workspace) return { size: 0, isDir: true };
        const d = files.get(path);
        return d === undefined ? null : { size: d.byteLength, isDir: false };
      },
      exec: async (_h: unknown, a: { command: string; cwd: string }) => {
        execs.push({ command: a.command, cwd: a.cwd });
        // find (Glob), grep (Grep: no match), the background launch (prints its session id)
        const stdout = a.command.startsWith("find")
          ? "./a.txt\0"
          : a.command.startsWith("grep")
            ? ""
            : "4242\n";
        const exitCode = a.command.startsWith("grep") ? 1 : 0;
        return { exitCode, stdout, stderr: "", truncated: false, timedOut: false };
      },
    };
    const body = (t: string) => new Response(t).body as ReadableStream<Uint8Array>;
    const tools = sandboxTools({
      devices,
      background: {
        reserve: async () => true,
        markStarted: async (_id: string, to: { outputPath?: string }) => {
          started.push(to.outputPath ?? "");
          return "started";
        },
        failLaunch: async () => {},
        finishStoppedLaunch: async () => {},
        releaseStop: async () => {},
        get: async () => undefined,
        advanceOffset: async () => {},
        // biome-ignore lint/suspicious/noExplicitAny: test stub
      } as any,
      sandbox: {
        cloudAvailable: true,
        availableFor: async () => true,
        currentInstance: async () => ({ createdAt: new Date(0) }),
        withSandbox: async (_c, fn, sig) => {
          entered++;
          return fn(
            { id: "env-1", roots: ROOTS },
            p as never,
            { fresh: false, restarted: false, roots: ROOTS },
            sig,
          );
        },
      },
      attachments: {
        listForConversation: async () => attachments,
        openForConversation: async (_o: string, _c: string, id: string) => ({
          name: id,
          contentType: "text/plain",
          size: 2,
          body: body("ok"),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: test stub
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: never called
      storage: {} as any,
      eventLog: {
        append: async () => [],
        latestFileState: async () => null,
      },
      config: { get: () => cfg },
    });
    const tool = (name: string) => tools.find((t) => t.spec.name === name) as BuiltinTool;
    return { files, writes, execs, started, tool, entered: () => entered };
  }

  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";

  it("Write under custom roots lands in the device workspace", async () => {
    const d = device();
    const r = await d
      .tool("Write")
      .run({ file_path: `${ROOTS.workspace}/a.txt`, content: "hi" }, ctx);
    expect(d.writes).toEqual([`${ROOTS.workspace}/a.txt`]);
    expect(text(r)).toBe(`Created ${ROOTS.workspace}/a.txt (2 bytes).`);
    await expect(
      d.tool("Write").run({ file_path: `${ROOTS.skills}/x/run.sh`, content: "x" }, ctx),
    ).rejects.toThrow(
      `Path ${ROOTS.skills}/x/run.sh is read-only (${ROOTS.skills} holds skill files); pass a path under ${ROOTS.workspace} or ${ROOTS.tmp} instead.`,
    );
  });

  it("a /workspace path is refused under custom roots with an actionable error naming the real workspace", async () => {
    const d = device();
    await expect(d.tool("Read").run({ file_path: "/workspace/a.txt" }, ctx)).rejects.toThrow(
      `Invalid file_path "/workspace/a.txt": path must be under ${ROOTS.workspace}, ${ROOTS.skills}, ${ROOTS.tmp}. Pass an absolute path under ${ROOTS.workspace}, ${ROOTS.skills} or ${ROOTS.tmp}.`,
    );
    expect(d.writes).toEqual([]);
  });

  it("default roots keep the old path error, byte for byte", async () => {
    const d = device();
    const tools = sandboxTools({
      devices,
      sandbox: {
        cloudAvailable: true,
        availableFor: async () => true,
        withSandbox: async (_c, fn, sig) =>
          fn(
            { id: "x" },
            {} as never,
            { fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS },
            sig,
          ),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      attachments: { listForConversation: async () => [] } as any,
      // biome-ignore lint/suspicious/noExplicitAny: never called
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: never called
      eventLog: {} as any,
      config: { get: () => cfg },
    });
    void d;
    const read = tools.find((t) => t.spec.name === "Read") as BuiltinTool;
    await expect(read.run({ file_path: "/etc/passwd" }, ctx)).rejects.toThrow(
      'Invalid file_path "/etc/passwd": path must be under /workspace, /skills, /tmp. Pass an absolute path under /workspace, /skills or /tmp.',
    );
  });

  it("attachments copy to <workspace>/attachments/<conv12>", async () => {
    const d = device([{ id: "a1", name: "data.csv" }]);
    d.files.set(`${ROOTS.workspace}/f.txt`, new TextEncoder().encode("hello\n"));
    const r = await d.tool("Read").run({ file_path: `${ROOTS.workspace}/f.txt` }, ctx);
    const dir = `${ROOTS.workspace}/attachments/0123abcd4567`;
    expect(d.writes).toEqual([`${dir}/data.csv`, `${dir}/.capybara-sync.json`]);
    expect(text(r)).toContain(`Attachments copied into the sandbox: ${dir}/data.csv.`);
  });

  it("Glob and Grep default to the instance's workspace and hide its sync markers", async () => {
    const d = device();
    const g = await d.tool("Glob").run({ pattern: "*.txt" }, ctx);
    expect(text(g)).toBe(`${ROOTS.workspace}/a.txt`);
    const r = await d.tool("Grep").run({ pattern: "x" }, ctx);
    expect(text(r)).toBe(`No matches for x in ${ROOTS.workspace}.`);
    expect(d.execs.map((e) => e.cwd)).toEqual([ROOTS.workspace, ROOTS.workspace]);
    const isSyncMarkerEntry = syncMarkerMatcher(ROOTS);
    expect(isSyncMarkerEntry(`${ROOTS.workspace}/attachments/c/.capybara-sync.json`)).toBe(true);
    expect(isSyncMarkerEntry("/workspace/attachments/c/.capybara-sync.json")).toBe(false);
  });

  it("a malformed path is refused before the call enters its device", async () => {
    const d = device();
    for (const [name, input] of [
      ["Read", { file_path: "relative.txt" }],
      ["Write", { file_path: "/a/../b", content: "x" }],
      ["Edit", { file_path: "/a//b", old_string: "a", new_string: "b" }],
      ["Glob", { pattern: "*", path: "rel" }],
      ["Grep", { pattern: "x", path: "/a/\u0001" }],
    ] as const) {
      await expect(d.tool(name).run(input, ctx), name).rejects.toThrow(
        /Pass an absolute path under the workspace, skills or temporary files directory\.$/,
      );
    }
    expect(d.entered()).toBe(0);
  });

  it("background Bash under custom roots: cwd, the started text and an absolute output path", async () => {
    const d = device();
    const r = await d
      .tool("Bash")
      .run({ command: "sleep 5", description: "Sleep", run_in_background: true }, ctx);
    expect(d.execs.map((e) => e.cwd)).toEqual([ROOTS.workspace]);
    const id = /Started background task (bt_[a-z2-7]{6})/.exec(text(r))?.[1];
    expect(text(r)).toBe(startedText(id as string, "Sleep", ROOTS.workspace));
    expect(text(r)).toContain(`Output: ${ROOTS.workspace}/.capybara/tasks/${id}.out`);
    expect(d.started).toEqual([`${ROOTS.workspace}/.capybara/tasks/${id}.out`]);
    expect(taskOutputFile(d.started[0] as string)).toBe(d.started[0]);
    expect(taskOutputFile(".capybara/tasks/bt_aaaaaa.out")).toBe(
      "/workspace/.capybara/tasks/bt_aaaaaa.out",
    );
  });

  it("descriptions name no root path and no operating system (the agreed wording)", () => {
    const d = device();
    const specs = [
      ...[
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Deliver",
        "TaskOutput",
        "TaskStop",
        "TaskList",
      ].map((n) => d.tool(n).spec),
      skillLoadTool({} as never).spec,
    ];
    for (const spec of specs) {
      const json = JSON.stringify(spec);
      for (const banned of ["/workspace", "/skills", "/tmp", "Linux"]) {
        expect(json, `${spec.name}: ${banned}`).not.toContain(banned);
      }
    }
    const bash = d.tool("Bash").spec.description;
    expect(bash).toContain(
      "Run a shell command (bash) in this conversation's sandbox, an isolated machine.",
    );
    expect(bash).toContain("The working directory is the workspace directory; files persist");
    expect(d.tool("Read").spec.description).toContain(
      "Paths are absolute, under the workspace directory, the skills directory or the temporary files directory.",
    );
    expect(d.tool("Write").spec.description).toContain(
      "The path is absolute, under the workspace directory or the temporary files directory (the skills directory is read-only).",
    );
  });
});

describe("sandbox tools listed by the conversation's device (ruling R8)", () => {
  const cfg = KernelConfigSchema.parse({
    db: { url: "postgres://x/y" },
    redis: { url: "redis://x" },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const bash = (usable: (orgId: string, conversationId: string) => Promise<boolean>) =>
    sandboxTools({
      devices: { forTool: async () => "env-1", usableNow: usable },
      sandbox: {
        cloudAvailable: false,
        availableFor: async () => true,
        withSandbox: async () => {
          throw new Error("not used");
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: never called
      attachments: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: never called
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: never called
      eventLog: {} as any,
      config: { get: () => cfg },
    }).find((t) => t.spec.name === "Bash") as BuiltinTool;

  it("a conversation on a local device gets the tools without a cloud provider", async () => {
    const seen: string[] = [];
    const tool = bash(async (_o, c) => {
      seen.push(c);
      return c === "device-conv";
    });
    expect(await tool.unavailable?.({ orgId: "o", conversationId: "device-conv" })).toBeNull();
    expect(await tool.unavailable?.({ orgId: "o", conversationId: "other" })).toMatch(
      /^No sandbox is configured/,
    );
    // a listing without a conversation (the Platform tool's view) asks the cloud provider only
    expect(await tool.unavailable?.({ orgId: "o" })).toMatch(/^No sandbox is configured/);
    expect(seen).toEqual(["device-conv", "other"]);
  });
});
