import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import {
  canonicalRoot,
  pathAgainstWorkingRoot,
  type WorkingProject,
  workingRootOf,
} from "../../../src/devices/working-root.js";
import { MANAGED_DEVICE_CONTEXT_STALE_TEXT } from "../../../src/sandbox/managed-device-context.js";
import { reviewRules, reviewWrite } from "../../../src/sandbox/review/index.js";
import { sandboxStartedNotice } from "../../../src/tools/builtins/sandbox/common.js";
import { sandboxTools } from "../../../src/tools/builtins/sandbox/index.js";
import { listFilesCommand } from "../../../src/tools/builtins/sandbox/search-command.js";
import type { BuiltinTool } from "../../../src/tools/registry.js";
import { managedCall, managedRoute, managedSandbox } from "../../helpers/managed-tool-stubs.js";

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
  const auto = { workspace: ROOTS.workspace };

  it("is the project's root when the latest snapshot is usable", () => {
    expect(workingRootOf(usable(PROJECT), auto)).toBe(PROJECT);
    expect(workingRootOf(usable(`${PROJECT}/`), auto)).toBe(PROJECT);
    expect(workingRootOf(usable(`${ROOTS.workspace}/app`), auto)).toBe(`${ROOTS.workspace}/app`);
    // where a project may lie is its provider's rule (checked when it was added), not the kernel's
    expect(workingRootOf(usable(`${ROOTS.workspace}-x`), auto)).toBe(`${ROOTS.workspace}-x`);
  });

  it("is the device's workspace when free, before the first snapshot, or unavailable", () => {
    expect(workingRootOf(null, auto)).toBe(ROOTS.workspace);
    expect(workingRootOf(undefined, auto)).toBe(ROOTS.workspace);
    expect(workingRootOf({ root: PROJECT, unavailable: true }, auto)).toBe(ROOTS.workspace);
  });

  it("never widens: malformed, or above every home", () => {
    for (const bad of ["relative/app", "/a/../b", "/a//b", "/a/\u0001"]) {
      expect(workingRootOf(usable(bad), auto), bad).toBe(ROOTS.workspace);
    }
    // `/` and the ancestors of a home directory are too broad
    // in any case: a macOS volume is case-insensitive, so /users is /Users
    for (const broad of ["/", "/Users", "/Users/", "/home", "/users", "/HOME", "/uSeRs/"]) {
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

describe("canonicalRoot", () => {
  it("compares roots in one form: normalized, no trailing slash, / kept (B-18)", () => {
    expect(canonicalRoot("/workspace/")).toBe("/workspace");
    expect(canonicalRoot("/workspace//app/./")).toBe("/workspace/app");
    expect(canonicalRoot("/")).toBe("/");
    expect(canonicalRoot("/srv/app")).toBe("/srv/app");
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
    const workspace = workingRootOf(usable("/Users/u"), { workspace: ROOTS.workspace });
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
  const ctx = managedCall({
    orgId: "o",
    accountId: "a",
    agentId: "g",
    conversationId: "0123abcd-4567-4890-8bcd-ef0123456789",
    rootConversationId: "0123abcd-4567-4890-8bcd-ef0123456789",
    callId: "call",
    signal: new AbortController().signal,
  });

  /**
   * A device whose root conversation has the project snapshot `project` (null: free); `fresh`:
   * the call is the conversation's first use of the device. On the managed route the call runs in
   * the working root its held evidence names, which `OperationAuthority.workingRootFor` decides
   * with the same `workingRootOf` rule from the held instance's workspace
   * (src/sandbox/operation-authority.ts).
   */
  function device(project: WorkingProject | null, { fresh = false }: { fresh?: boolean } = {}) {
    const files = new Map<string, Uint8Array>();
    const dirs = new Set([ROOTS.workspace, PROJECT, `${ROOTS.workspace}/app`]);
    const writes: string[] = [];
    const execs: { command: string; cwd: string }[] = [];
    /** The file states the conversation recorded (what Read leaves for a later Edit). */
    const states = new Map<string, { size: number; sha256: string }>();
    const devicesAsked: string[] = [];
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
        const stdout =
          a.command === listFilesCommand()
            ? "./a.txt\0"
            : a.command.includes("grep -r")
              ? ""
              : "4242\n";
        const exitCode = a.command.includes("grep -r") ? 1 : 0;
        return { exitCode, stdout, stderr: "", truncated: false, timedOut: false };
      },
    };
    const managed = managedSandbox(p, {
      roots: ROOTS,
      handle: { id: "env-1", roots: ROOTS },
      info: { fresh },
      workingRoot: workingRootOf(project, { workspace: ROOTS.workspace, home: "/Users/u" }),
    });
    const tools = sandboxTools({
      devices: {
        forTool: async (_orgId: string, conversationId: string) => {
          devicesAsked.push(conversationId);
          return "env-1";
        },
      },
      background: {
        get: async () => undefined,
        advanceOffset: async () => {},
        // biome-ignore lint/suspicious/noExplicitAny: test stub
      } as any,
      sandbox: {
        currentInstance: async () => ({ createdAt: new Date(0), provider: "device-fake" }),
        ...managed.sandbox,
      },
      ...managedRoute(),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      attachments: { listForConversation: async () => [] } as any,
      // biome-ignore lint/suspicious/noExplicitAny: never called
      storage: {} as any,
      eventLog: {
        append: async () => [],
        readDeliveryScope: async () => ({ boundary: 0, artifacts: [] }),
        latestFileState: async (_c: string, path: string) => states.get(path) ?? null,
      },
      config: { get: () => cfg },
    });
    const tool = (name: string) => tools.find((t) => t.spec.name === name) as BuiltinTool;
    return {
      files,
      writes,
      execs,
      devicesAsked,
      entries: managed.entries,
      states,
      tool,
      entered: () => managed.entries.length,
    };
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

  it("a reviewed call runs in the working root its review judged", async () => {
    // the held evidence names the project root, which the review judged the call against
    const d = device(usable(PROJECT));
    await d.tool("Bash").run(bash, { ...ctx, reviewedWorkingRoot: `${PROJECT}/` });
    expect(d.execs.map((e) => e.cwd)).toEqual([PROJECT]);
    await d
      .tool("Write")
      .run({ file_path: "a.txt", content: "a" }, { ...ctx, reviewedWorkingRoot: PROJECT });
    expect(d.writes).toEqual([`${PROJECT}/a.txt`]);
    // held evidence of another root than the reviewed one is stale: refused before the callback
    // (B-18, inSandboxWith's beforeUser in src/tools/builtins/sandbox/common.ts)
    await expect(
      d.tool("Bash").run(bash, { ...ctx, reviewedWorkingRoot: "/Users/u/code/reviewed" }),
    ).rejects.toThrow(MANAGED_DEVICE_CONTEXT_STALE_TEXT);
    expect(d.execs).toHaveLength(1);
  });

  it("a sub-agent's call uses its root conversation's device and holds it as itself", async () => {
    const d = device(usable(PROJECT));
    await d.tool("Bash").run(bash, { ...ctx, sandboxConversationId: "root-conv" });
    // the stub's evidence working root is fixed here: the real derivation for a child (the
    // holder's root conversation, `workingRootFor`) is test/sandbox/permission-wiring.test.ts
    // (around line 319)
    expect(d.devicesAsked).toEqual(["root-conv"]);
    expect(d.entries.map((e) => e.use.holderConversationId)).toEqual([ctx.conversationId]);
    expect(d.execs.map((e) => e.cwd)).toEqual([PROJECT]);
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
