import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { AppendEvent } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { RecordedToolPipeline, recordedCalls } from "../../src/evals/recorded-tools.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import { environmentPathsText } from "../../src/runtime/context/environment-paths.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { type SandboxToolDeps, sandboxTools } from "../../src/tools/builtins/sandbox/index.js";
import type { BuiltinTool } from "../../src/tools/registry.js";
import { AGENT, Log, MODEL } from "./context/fixtures.js";

/**
 * Environments phase 2 (spec §13.1): a connected machine's instance has its own roots; the model is
 * told them once per conversation by an `environment_paths` event, rendered as a system line.
 */

const ROOTS: SandboxRoots = {
  workspace: "/Users/u/capybara-device/e1/workspace",
  skills: "/Users/u/capybara-device/e1/skills",
  tmp: "/Users/u/capybara-device/e1/tmp",
};

const LINE =
  "This environment's directories: workspace /Users/u/capybara-device/e1/workspace, skills /Users/u/capybara-device/e1/skills (read only), temporary files /Users/u/capybara-device/e1/tmp. Use these paths in commands and tool calls.";

const cfg = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});

/** A conversation's log as the tools append to it (idempotency keys honoured). */
function memLog() {
  const appended: (AppendEvent & { conversationId: string })[] = [];
  const byKey = new Map<string, AppendEvent>();
  return {
    appended,
    eventLog: {
      append: async (conversationId: string, events: AppendEvent[]) => {
        for (const e of events) {
          if (e.idemKey !== undefined && byKey.has(`${conversationId}:${e.idemKey}`)) continue;
          if (e.idemKey !== undefined) byKey.set(`${conversationId}:${e.idemKey}`, e);
          appended.push({ ...e, conversationId });
        }
        return [];
      },
      findByIdem: async (conversationId: string, key: string) =>
        byKey.get(`${conversationId}:${key}`) as never,
      latestFileState: async () => null,
    },
  };
}

/** An in-memory instance with `roots` (absent: a cloud instance without roots). */
function memTools(roots: SandboxRoots | undefined) {
  const files = new Map<string, Uint8Array>();
  const log = memLog();
  const p = {
    readFile: async (_h: unknown, path: string) => {
      const d = files.get(path);
      return d === undefined ? null : { data: d, truncated: false };
    },
    writeFile: async (_h: unknown, path: string, data: Uint8Array) => {
      files.set(path, data);
    },
    stat: async (_h: unknown, path: string) => {
      const d = files.get(path);
      return d === undefined ? null : { size: d.byteLength, isDir: false };
    },
  };
  const h = { id: "env-1", ...(roots !== undefined && { roots }) };
  const deps: SandboxToolDeps = {
    environments: { forTool: async () => "env-1" },
    sandbox: {
      cloudAvailable: true,
      availableFor: async () => true,
      withSandbox: async (_c, fn, sig) =>
        fn(
          h,
          p as never,
          { fresh: false, restarted: false, roots: roots ?? DEFAULT_SANDBOX_ROOTS },
          sig,
        ),
    },
    attachments: {
      listForConversation: async () => [],
      openForConversation: async () => null,
    },
    // biome-ignore lint/suspicious/noExplicitAny: never called
    storage: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: append / findByIdem / latestFileState only
    eventLog: log.eventLog as any,
    config: { get: () => cfg },
  };
  const tool = (name: string) =>
    sandboxTools(deps).find((t) => t.spec.name === name) as BuiltinTool;
  const ctx = {
    orgId: "o",
    conversationId: "c",
    runId: "r",
    callId: "call-1",
    accountId: "acc",
    signal: new AbortController().signal,
    // biome-ignore lint/suspicious/noExplicitAny: only these fields are read
  } as any;
  return { files, log, tool, ctx };
}

describe("environment_paths: recorded by the sandbox tools", () => {
  it("environment_paths is recorded once and rendered as a system line", async () => {
    const t = memTools(ROOTS);
    await t.tool("Write").run({ file_path: `${ROOTS.workspace}/a.txt`, content: "a" }, t.ctx);
    await t.tool("Write").run({ file_path: `${ROOTS.tmp}/b.txt`, content: "b" }, t.ctx);
    const paths = t.log.appended.filter((e) => e.type === "environment_paths");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ conversationId: "c", runId: "r", payload: { roots: ROOTS } });

    // rendered after the step's tool results, as recorded between the call and its result
    const log = new Log();
    log.user("write a file");
    log.modelCall(1, 1);
    log.assistant(
      [{ type: "tool_call", id: "call-1", name: "Write", input: { file_path: "x" } }],
      "tool_use",
      1,
    );
    log.add({ type: "environment_paths", payload: { roots: ROOTS } });
    log.add({
      type: "tool_result",
      payload: { step: 1, callId: "call-1", toolKey: "Write", content: "ok", isError: false },
    });
    const { request } = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 2,
    });
    expect(request.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(request.messages[3]).toEqual({ role: "system", content: LINE });
    expect(environmentPathsText(ROOTS)).toBe(LINE);
  });

  it("default roots record no environment_paths event", async () => {
    for (const roots of [undefined, { ...DEFAULT_SANDBOX_ROOTS }]) {
      const t = memTools(roots);
      await t.tool("Write").run({ file_path: "/workspace/a.txt", content: "a" }, t.ctx);
      expect(t.log.appended.filter((e) => e.type === "environment_paths")).toEqual([]);
    }
  });

  it("a summary covering the event restores the line right after the summary", () => {
    const log = new Log();
    log.user("hi");
    log.add({ type: "environment_paths", payload: { roots: ROOTS } });
    log.assistant("done");
    const covered = log.events.at(-1)?.seq as number;
    log.summary(covered, "earlier work");
    log.user("next");
    const { request } = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
    });
    expect(request.messages[1]).toEqual({ role: "system", content: LINE });
    expect(request.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("is left out of the compaction transcript (the summary is followed by the line anyway)", () => {
    const log = new Log();
    log.user("hi");
    log.add({ type: "environment_paths", payload: { roots: ROOTS } });
    log.assistant("done");
    log.user("more");
    log.assistant("ok");
    const plan = compactionPlan(log.events, 1);
    expect(plan?.transcript).toContain("User: hi");
    expect(JSON.stringify(plan)).not.toContain("This environment's directories");
  });
});

describe("environment_paths: full-run replay", () => {
  /** A one-run snapshot: one `Write` call whose result follows an `environment_paths` event. */
  function snap(): CaseSnapshot {
    const events: CaseSnapshot["events"] = [];
    let seq = 1;
    const ev = (type: string, payload: unknown) =>
      events.push({ seq: seq++, type, payload, runId: "r", createdAt: "" } as never);
    ev("assistant_message", {
      step: 1,
      stopReason: "tool_use",
      content: [{ type: "tool_call", id: "c0", name: "Write", input: { file_path: "f" } }],
    });
    ev("tool_call_started", { step: 1, callId: "c0", toolKey: "Write", specHash: "h" });
    ev("environment_paths", { roots: ROOTS });
    ev("tool_result", { step: 1, callId: "c0", toolKey: "Write", content: "ok", isError: false });
    return {
      version: 1,
      orgId: "o",
      conversationId: "c",
      runId: "r",
      agentId: "a",
      agentVersion: 1,
      events,
      definitions: {},
      toolSpecs: {},
    };
  }

  it("a replayed call that matched copies the recorded environment_paths event, never twice", async () => {
    const recordings = recordedCalls(snap());
    expect(recordings[0]?.environmentPaths).toEqual(ROOTS);
    const log = memLog();
    const assistant = {
      type: "assistant_message",
      payload: {
        step: 1,
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: "x0", name: "Write", input: { file_path: "f" } }],
      },
    } as unknown as ConversationEvent;
    const eventLog = {
      ...log.eventLog,
      findByIdem: async (conversationId: string, key: string) =>
        key === assistantIdemKey("r2", 1)
          ? assistant
          : log.eventLog.findByIdem(conversationId, key),
    };
    const pipeline = new RecordedToolPipeline({
      // biome-ignore lint/suspicious/noExplicitAny: append / findByIdem only
      eventLog: eventLog as any,
      recordings,
      beforeStep: async () => "continue",
    });
    await pipeline.runStep({ conversationId: "e", runId: "r2", step: 1 } as never);
    const types = log.appended.map((e) => e.type);
    expect(types).toEqual(["environment_paths", "tool_call_started", "tool_result"]);
    expect(log.appended[0]).toMatchObject({ runId: "r2", payload: { roots: ROOTS } });
  });
});
