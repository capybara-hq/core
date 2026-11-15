import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import {
  pathAgainstWorkingRoot,
  type WorkingProject,
  workingRootOf,
} from "../../../src/devices/working-root.js";
import type { SandboxMode } from "../../../src/sandbox/modes.js";
import { reviewRules, reviewWrite } from "../../../src/sandbox/review/index.js";
import { sandboxStartedNotice } from "../../../src/tools/builtins/sandbox/common.js";
import { sandboxTools } from "../../../src/tools/builtins/sandbox/index.js";
import type { BuiltinTool } from "../../../src/tools/registry.js";

/**
 * Project root spec §4.3: the project root is the conversation's working directory. One helper
 * decides the working root (the root conversation's latest usable `project_root`, else the
 * device's workspace); `Bash` runs there, `Glob` / `Grep` search there by default, a relative
 * `Read` / `Write` / `Edit` path resolves there, and it is the command review's `workspace` fact.
 */

const ROOTS: SandboxRoots = {
  workspace: "/Users/u/capybara-device/e1/workspace",
  skills: "/Users/u/capybara-device/e1/skills",
  tmp: "/Users/u/capybara-device/e1/tmp",
};
const PROJECT = "/Users/u/code/app";
const usable = (root: string): WorkingProject => ({ root, unavailable: false });

describe("workingRootOf", () => {
  const auto = { mode: "auto" as const, workspace: ROOTS.workspace };
  const sandbox = { mode: "sandbox" as const, workspace: ROOTS.workspace };

  it("is the project's root when the latest snapshot is usable", () => {
    expect(workingRootOf(usable(PROJECT), auto)).toBe(PROJECT);
    expect(workingRootOf(usable(`${PROJECT}/`), auto)).toBe(PROJECT);
    expect(workingRootOf(usable(`${ROOTS.workspace}/app`), sandbox)).toBe(`${ROOTS.workspace}/app`);
  });

  it("is the device's workspace when free, before the first snapshot, or unavailable", () => {
    expect(workingRootOf(null, auto)).toBe(ROOTS.workspace);
    expect(workingRootOf(undefined, auto)).toBe(ROOTS.workspace);
    expect(workingRootOf({ root: PROJECT, unavailable: true }, auto)).toBe(ROOTS.workspace);
  });

  it("never widens: outside the workspace in sandbox mode, malformed, or above every home", () => {
    expect(workingRootOf(usable(PROJECT), sandbox)).toBe(ROOTS.workspace);
    // a sibling whose name only starts with the workspace's
    expect(workingRootOf(usable(`${ROOTS.workspace}-x`), sandbox)).toBe(ROOTS.workspace);
    for (const bad of ["relative/app", "/a/../b", "/a//b", "/a/\u0001"]) {
      expect(workingRootOf(usable(bad), auto), bad).toBe(ROOTS.workspace);
    }
    // `/` and the ancestors of a home directory are too broad
    for (const broad of ["/", "/Users", "/Users/", "/home"]) {
      expect(workingRootOf(usable(broad), auto), broad).toBe(ROOTS.workspace);
    }
    // the owner's home itself is a project the owner chose: the review keeps its home-level rules
    expect(workingRootOf(usable("/Users/u"), auto)).toBe("/Users/u");
    expect(workingRootOf(usable("/home/u/"), auto)).toBe("/home/u");
    expect(workingRootOf(usable("/root"), auto)).toBe("/root");
    // every ancestor of the owner's reported home is too broad, wherever that home is
    const varHome = { ...auto, home: "/var/lib/u" };
    for (const broad of ["/var", "/var/lib", "/var/lib/"]) {
      expect(workingRootOf(usable(broad), varHome), broad).toBe(ROOTS.workspace);
    }
    expect(workingRootOf(usable("/var/lib/u"), varHome)).toBe("/var/lib/u");
    expect(workingRootOf(usable("/var/lib/u/app"), varHome)).toBe("/var/lib/u/app");
    expect(workingRootOf(usable("/var/lib/other"), varHome)).toBe("/var/lib/other");
    expect(workingRootOf(usable("/home/u/app"), auto)).toBe("/home/u/app");
    expect(workingRootOf(usable("/root/app"), auto)).toBe("/root/app");
  });
});

describe("pathAgainstWorkingRoot", () => {
  it("joins a relative path to the working root as the review judged it; keeps / and ~ paths", () => {
    expect(pathAgainstWorkingRoot("src/./a.ts", PROJECT)).toBe(`${PROJECT}/src/a.ts`);
    expect(pathAgainstWorkingRoot("../x", PROJECT)).toBe("/Users/u/code/x");
    expect(pathAgainstWorkingRoot("/etc/hosts", PROJECT)).toBe("/etc/hosts");
    expect(pathAgainstWorkingRoot("~/.bashrc", PROJECT)).toBe("~/.bashrc");
  });
});

describe("the review with the working root as its workspace fact", () => {
  const facts = { workspace: PROJECT, mode: "auto" as const, attended: true };

  it("a write inside the project root outside the device workspace is allowed, not asked", () => {
    expect(reviewWrite(`${PROJECT}/src/main.ts`, facts).outcome).toBe("allow");
    expect(reviewWrite("src/main.ts", facts).outcome).toBe("allow");
    expect(reviewRules("touch src/new.ts", facts).outcome).toBe("allow");
  });

  it("inside a home-directory project, rc files and SSH still ask; an ordinary file is allowed", () => {
    const workspace = workingRootOf(usable("/Users/u"), {
      mode: "auto",
      workspace: ROOTS.workspace,
    });
    const home = { workspace, mode: "auto" as const, attended: true };
    expect(reviewWrite("/Users/u/.bashrc", home).hits.map((h) => h.id)).toEqual([
      "ask.shell-config",
    ]);
    expect(reviewWrite("~/.ssh/config", home).hits.map((h) => h.id)).toEqual(["ask.ssh"]);
    expect(reviewRules("echo x >> ~/.bashrc", home).outcome).toBe("ask");
    expect(reviewWrite("/Users/u/code/app/main.ts", home).outcome).toBe("allow");
    expect(reviewWrite("notes.md", home).outcome).toBe("allow");
  });

  it("a write outside the project root still asks, the device workspace included", () => {
    expect(reviewWrite("/Users/u/code/other/x.ts", facts).hits.map((h) => h.id)).toEqual([
      "ask.outside-write",
    ]);
    expect(reviewWrite(`${ROOTS.workspace}/x.txt`, facts).outcome).toBe("ask");
    expect(reviewWrite("~/.zshrc", facts).outcome).toBe("ask");
  });
});

describe("sandboxStartedNotice", () => {
  it("names the working root when a project is bound, and is unchanged otherwise", () => {
    expect(sandboxStartedNotice(ROOTS)).toBe(
      `Device started (first use in this conversation); the working directory is ${ROOTS.workspace}, shared with the device's other conversations.`,
    );
    expect(sandboxStartedNotice(ROOTS, ROOTS.workspace)).toBe(sandboxStartedNotice(ROOTS));
    expect(sandboxStartedNotice(ROOTS, PROJECT)).toBe(
      `Device started (first use in this conversation); the working directory is ${PROJECT}, the project's root, on a device shared with other conversations.`,
    );
  });
});

describe("the sandbox tools in a bound conversation", () => {
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

  /**
   * A device at `mode` whose root conversation has the project snapshot `project` (null: free);
   * `fresh`: the call is the conversation's first use of the device.
   */
  function device(
    project: WorkingProject | null,
    {
      mode = "auto",
      fresh = false,
      recorded = ROOTS.workspace,
    }: { mode?: SandboxMode; fresh?: boolean; recorded?: string } = {},
  ) {
    const files = new Map<string, Uint8Array>();
    const dirs = new Set([ROOTS.workspace, PROJECT, `${ROOTS.workspace}/app`]);
    const writes: string[] = [];
    const execs: { command: string; cwd: string }[] = [];
    const asked: string[] = [];
    /** The file states the conversation recorded (what Read leaves for a later Edit). */
    const states = new Map<string, { size: number; sha256: string }>();
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
        if (dirs.has(path)) return { size: 0, isDir: true };
        const d = files.get(path);
        return d === undefined ? null : { size: d.byteLength, isDir: false };
      },
      exec: async (_h: unknown, a: { command: string; cwd: string }) => {
        execs.push({ command: a.command, cwd: a.cwd });
        const stdout = a.command.startsWith("find")
          ? "./a.txt\0"
          : a.command.startsWith("grep")
            ? ""
            : "4242\n";
        const exitCode = a.command.startsWith("grep") ? 1 : 0;
        return { exitCode, stdout, stderr: "", truncated: false, timedOut: false };
      },
    };
    const tools = sandboxTools({
      devices: {
        forTool: async () => "env-1",
        modeLevel: async () => ({
          mode,
          allowedMode: "auto",
          network: { kind: "open-public", hosts: [] },
          local: true,
        }),
        workingFacts: async (_orgId: string, rootConversationId: string) => {
          asked.push(rootConversationId);
          return { workspace: recorded, home: "/Users/u", project };
        },
      },
      background: {
        reserve: async () => true,
        markStarted: async () => "started",
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
            { fresh, restarted: false, roots: ROOTS },
            sig,
          );
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      attachments: { listForConversation: async () => [] } as any,
      // biome-ignore lint/suspicious/noExplicitAny: never called
      storage: {} as any,
      eventLog: {
        append: async () => [],
        latestFileState: async (_c: string, path: string) => states.get(path) ?? null,
      },
      config: { get: () => cfg },
    });
    const tool = (name: string) => tools.find((t) => t.spec.name === name) as BuiltinTool;
    return { files, writes, execs, asked, states, tool, entered: () => entered };
  }

  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
  const bash = { command: "ls", description: "List" };

  it("Bash runs in the project root, and in the workspace without a usable project", async () => {
    const bound = device(usable(PROJECT));
    await bound.tool("Bash").run(bash, ctx);
    expect(bound.execs.map((e) => e.cwd)).toEqual([PROJECT]);
    const free = device(null);
    await free.tool("Bash").run(bash, ctx);
    expect(free.execs.map((e) => e.cwd)).toEqual([ROOTS.workspace]);
    const gone = device({ root: PROJECT, unavailable: true });
    await gone.tool("Bash").run(bash, ctx);
    expect(gone.execs.map((e) => e.cwd)).toEqual([ROOTS.workspace]);
  });

  it("the project decision uses the review's workspace source; a fallback runs in the instance's workspace", async () => {
    // sandbox mode: the review's recorded workspace does not hold the project, so neither does the
    // tool's decision, even though the held instance's workspace would
    const stale = device(usable(`${ROOTS.workspace}/app`), {
      mode: "sandbox",
      recorded: "/workspace",
    });
    await stale.tool("Bash").run(bash, ctx);
    expect(stale.execs.map((e) => e.cwd)).toEqual([ROOTS.workspace]);
    // free mode with a stale record: the command runs where the instance really is
    const free = device(null, { recorded: "/workspace" });
    await free.tool("Bash").run(bash, ctx);
    expect(free.execs.map((e) => e.cwd)).toEqual([ROOTS.workspace]);
  });

  it("a reviewed call runs in the working root its review judged, without reading it again", async () => {
    const d = device(usable(PROJECT));
    await d.tool("Bash").run(bash, { ...ctx, reviewedWorkingRoot: "/Users/u/code/reviewed" });
    expect(d.execs.map((e) => e.cwd)).toEqual(["/Users/u/code/reviewed"]);
    expect(d.asked).toEqual([]);
    await d
      .tool("Write")
      .run(
        { file_path: "a.txt", content: "a" },
        { ...ctx, reviewedWorkingRoot: "/Users/u/code/reviewed" },
      );
    expect(d.writes).toEqual(["/Users/u/code/reviewed/a.txt"]);
  });

  it("a sub-agent's call reads its root conversation's project", async () => {
    const d = device(usable(PROJECT));
    await d.tool("Bash").run(bash, { ...ctx, sandboxConversationId: "root-conv" });
    expect(d.asked).toEqual(["root-conv"]);
    expect(d.execs.map((e) => e.cwd)).toEqual([PROJECT]);
  });

  it("a background Bash starts its command in the project root; its task files stay in the workspace", async () => {
    const d = device(usable(PROJECT));
    const r = await d
      .tool("Bash")
      .run({ command: "make build", description: "Build", run_in_background: true }, ctx);
    expect(text(r)).toContain(`Output: ${ROOTS.workspace}/.capybara/tasks/`);
    expect(d.execs.map((e) => e.cwd)).toEqual([ROOTS.workspace]);
    const b64 = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(d.execs[0]?.command ?? "")?.[1];
    expect(Buffer.from(b64 ?? "", "base64").toString("utf8")).toBe(
      `cd -- '${PROJECT}' || exit 1\nmake build`,
    );
    // free mode: the script is the command alone, as before
    const free = device(null);
    await free
      .tool("Bash")
      .run({ command: "make build", description: "Build", run_in_background: true }, ctx);
    const freeB64 = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(
      free.execs[0]?.command ?? "",
    )?.[1];
    expect(Buffer.from(freeB64 ?? "", "base64").toString("utf8")).toBe("make build");
  });

  it("Glob and Grep default to the project root", async () => {
    const d = device(usable(PROJECT));
    const g = await d.tool("Glob").run({ pattern: "*.txt" }, ctx);
    expect(text(g)).toBe(`${PROJECT}/a.txt`);
    const r = await d.tool("Grep").run({ pattern: "x" }, ctx);
    expect(text(r)).toBe(`No matches for x in ${PROJECT}.`);
    expect(d.execs.map((e) => e.cwd)).toEqual([PROJECT, PROJECT]);
  });

  it("a relative Read / Write / Edit path resolves against the project root", async () => {
    const d = device(usable(PROJECT));
    d.files.set(`${PROJECT}/src/a.txt`, new TextEncoder().encode("hello\n"));
    const read = await d.tool("Read").run({ file_path: "src/a.txt" }, ctx);
    expect(text(read)).toContain("hello");
    const view = (read as { view: { path: string; file: { size: number; sha256: string } } }).view;
    expect(view.path).toBe(`${PROJECT}/src/a.txt`);
    d.states.set(`${PROJECT}/src/a.txt`, view.file);
    const wrote = await d.tool("Write").run({ file_path: "./out/b.txt", content: "b" }, ctx);
    expect(text(wrote)).toBe(`Created ${PROJECT}/out/b.txt (1 bytes).`);
    await d
      .tool("Edit")
      .run({ file_path: "src/a.txt", old_string: "hello", new_string: "bye" }, ctx);
    expect(d.writes).toEqual([`${PROJECT}/out/b.txt`, `${PROJECT}/src/a.txt`]);
    expect(new TextDecoder().decode(d.files.get(`${PROJECT}/src/a.txt`))).toBe("bye\n");
  });

  it("a relative path in free mode resolves against the workspace", async () => {
    const d = device(null);
    await d.tool("Write").run({ file_path: "notes.md", content: "n" }, ctx);
    expect(d.writes).toEqual([`${ROOTS.workspace}/notes.md`]);
  });

  it("sandbox mode keeps its roots: the working root changes nothing the path checks accept", async () => {
    // a project root outside the workspace is never the working root in sandbox mode
    const outside = device(usable(PROJECT), { mode: "sandbox" });
    await outside.tool("Write").run({ file_path: "a.txt", content: "a" }, ctx);
    expect(outside.writes).toEqual([`${ROOTS.workspace}/a.txt`]);
    await expect(
      outside.tool("Write").run({ file_path: `${PROJECT}/a.txt`, content: "a" }, ctx),
    ).rejects.toThrow(/path must be under/);
    // inside the workspace it is, and the roots still bound every path
    const inside = device(usable(`${ROOTS.workspace}/app`), { mode: "sandbox" });
    await inside.tool("Write").run({ file_path: "a.txt", content: "a" }, ctx);
    expect(inside.writes).toEqual([`${ROOTS.workspace}/app/a.txt`]);
    await inside.tool("Bash").run(bash, ctx);
    expect(inside.execs.map((e) => e.cwd)).toEqual([`${ROOTS.workspace}/app`]);
  });

  it("a relative path with ~ or .. is refused before the call enters its device", async () => {
    const d = device(usable(PROJECT));
    for (const [name, input] of [
      ["Read", { file_path: "~/.ssh/id_rsa" }],
      ["Write", { file_path: "../other/x.txt", content: "x" }],
      ["Edit", { file_path: "src//a.txt", old_string: "a", new_string: "b" }],
      ["Read", { file_path: "." }],
      ["Write", { file_path: "a/%2e%2e/b", content: "x" }],
    ] as const) {
      await expect(d.tool(name).run(input, ctx), `${name} ${input.file_path}`).rejects.toThrow(
        /Pass an absolute path, or a path relative to the working directory without '\.\.' segments\.$/,
      );
    }
    expect(d.entered()).toBe(0);
  });

  it("the started notice of a bound conversation names the project root", async () => {
    const d = device(usable(PROJECT), { fresh: true });
    const r = await d.tool("Bash").run(bash, ctx);
    expect(text(r).startsWith(sandboxStartedNotice(ROOTS, PROJECT))).toBe(true);
    const free = device(null, { fresh: true });
    const f = await free.tool("Bash").run(bash, ctx);
    expect(text(f).startsWith(sandboxStartedNotice(ROOTS))).toBe(true);
  });
});
