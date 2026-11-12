import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { AppendEvent } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { RecordedToolPipeline, recordedCalls } from "../../src/evals/recorded-tools.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import {
  type DeviceSandboxLevel,
  devicePathsText,
  sandboxLevelText,
} from "../../src/runtime/context/device-paths.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { type SandboxToolDeps, sandboxTools } from "../../src/tools/builtins/sandbox/index.js";
import type { BuiltinTool } from "../../src/tools/registry.js";
import { AGENT, Log, MODEL } from "./context/fixtures.js";

/**
 * Devices, local phase (environments spec §13.1, ruling R22): the first sandbox call of every conversation
 * records the instance's roots in an `device_paths` event (rendered as a system line), and a
 * later call records them again whenever they changed.
 */

const ROOTS: SandboxRoots = {
  workspace: "/Users/u/capybara-device/e1/workspace",
  skills: "/Users/u/capybara-device/e1/skills",
  tmp: "/Users/u/capybara-device/e1/tmp",
};

const LINE =
  "This device's directories: workspace /Users/u/capybara-device/e1/workspace, skills /Users/u/capybara-device/e1/skills (read only), temporary files /Users/u/capybara-device/e1/tmp. Use these paths in commands and tool calls.";

const cfg = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});

type Logged = AppendEvent & { conversationId: string; seq: number };

/** A conversation's log as the tools append to it (seqs assigned, idempotency keys honoured). */
function memLog() {
  const appended: Logged[] = [];
  const byKey = new Map<string, Logged>();
  return {
    appended,
    eventLog: {
      append: async (conversationId: string, events: AppendEvent[]) => {
        for (const e of events) {
          if (e.idemKey !== undefined && byKey.has(`${conversationId}:${e.idemKey}`)) continue;
          const row = { ...e, conversationId, seq: appended.length + 1 };
          if (e.idemKey !== undefined) byKey.set(`${conversationId}:${e.idemKey}`, row);
          appended.push(row);
        }
        return [];
      },
      findByIdem: async (conversationId: string, key: string) =>
        byKey.get(`${conversationId}:${key}`) as never,
      latestOfType: async (conversationId: string, type: string) =>
        appended.findLast((e) => e.conversationId === conversationId && e.type === type) as never,
      latestFileState: async () => null,
    },
  };
}

/**
 * An in-memory instance with `roots` (absent: a cloud instance without roots); `setRoots` changes
 * the instance's roots for later calls (a replaced machine, a mode switch).
 */
function memTools(initial: SandboxRoots | undefined, initialLevel?: DeviceSandboxLevel | null) {
  let roots = initial;
  let level = initialLevel;
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
  const deps: SandboxToolDeps = {
    devices: {
      forTool: async () => "env-1",
      ...(level !== undefined && { sandboxLevel: async () => level ?? null }),
    },
    sandbox: {
      cloudAvailable: true,
      availableFor: async () => true,
      withSandbox: async (_c, fn, sig) =>
        fn(
          { id: "env-1", ...(roots !== undefined && { roots }) },
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
  const setRoots = (r: SandboxRoots | undefined) => {
    roots = r;
  };
  const setLevel = (l: DeviceSandboxLevel) => {
    level = l;
  };
  return { files, log, tool, ctx, setRoots, setLevel };
}

describe("device_paths: recorded by the sandbox tools", () => {
  it("device_paths is recorded on the first call, not again for the same roots, and rendered as a system line", async () => {
    const t = memTools(ROOTS);
    await t.tool("Write").run({ file_path: `${ROOTS.workspace}/a.txt`, content: "a" }, t.ctx);
    await t.tool("Write").run({ file_path: `${ROOTS.tmp}/b.txt`, content: "b" }, t.ctx);
    const paths = t.log.appended.filter((e) => e.type === "device_paths");
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
    log.add({ type: "device_paths", payload: { roots: ROOTS } });
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
    expect(devicePathsText({ roots: ROOTS })).toBe(LINE);
  });

  it("a cloud conversation's first call records the default roots (ruling R22)", async () => {
    for (const roots of [undefined, { ...DEFAULT_SANDBOX_ROOTS }]) {
      const t = memTools(roots);
      await t.tool("Write").run({ file_path: "/workspace/a.txt", content: "a" }, t.ctx);
      await t.tool("Write").run({ file_path: "/workspace/b.txt", content: "b" }, t.ctx);
      const paths = t.log.appended.filter((e) => e.type === "device_paths");
      expect(paths.map((e) => e.payload)).toEqual([{ roots: DEFAULT_SANDBOX_ROOTS }]);
    }
    expect(devicePathsText({ roots: DEFAULT_SANDBOX_ROOTS })).toBe(
      "This device's directories: workspace /workspace, skills /skills (read only), temporary files /tmp. Use these paths in commands and tool calls.",
    );
  });

  it("roots that change are recorded again, back to the defaults too (A, B, A)", async () => {
    const t = memTools(undefined);
    const write = (dir: string) =>
      t.tool("Write").run({ file_path: `${dir}/x-${Math.random()}.txt`, content: "x" }, t.ctx);
    await write("/workspace");
    t.setRoots(ROOTS);
    await write(ROOTS.workspace);
    await write(ROOTS.workspace);
    t.setRoots(undefined);
    await write("/workspace");
    t.setRoots(ROOTS);
    await write(ROOTS.workspace);
    const paths = t.log.appended.filter((e) => e.type === "device_paths");
    expect(paths.map((e) => (e.payload as { roots: SandboxRoots }).roots)).toEqual([
      DEFAULT_SANDBOX_ROOTS,
      ROOTS,
      DEFAULT_SANDBOX_ROOTS,
      ROOTS,
    ]);
    expect(new Set(paths.map((e) => e.idemKey)).size).toBe(4);
  });

  it("a summary covering the event restores the line right after the summary", () => {
    const log = new Log();
    log.user("hi");
    log.add({ type: "device_paths", payload: { roots: ROOTS } });
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
    log.add({ type: "device_paths", payload: { roots: ROOTS } });
    log.assistant("done");
    log.user("more");
    log.assistant("ok");
    const plan = compactionPlan(log.events, 1);
    expect(plan?.transcript).toContain("User: hi");
    expect(JSON.stringify(plan)).not.toContain("This device's directories");
  });
});

describe("device_paths: full-run replay", () => {
  /** A one-run snapshot: one `Write` call whose result follows an `device_paths` event. */
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
    ev("device_paths", { roots: ROOTS });
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

  /** A pipeline over `log` whose step `n` asked for the `Write` calls `inputs`. */
  function pipelineFor(
    recordings: ReturnType<typeof recordedCalls>,
    log: ReturnType<typeof memLog>,
    steps: Record<number, string[]>,
  ) {
    const assistant = (step: number) =>
      ({
        type: "assistant_message",
        payload: {
          step,
          stopReason: "tool_use",
          content: (steps[step] ?? []).map((f, i) => ({
            type: "tool_call",
            id: `x${step}-${i}`,
            name: "Write",
            input: { file_path: f },
          })),
        },
      }) as unknown as ConversationEvent;
    const eventLog = {
      ...log.eventLog,
      findByIdem: async (conversationId: string, key: string) => {
        for (const n of Object.keys(steps)) {
          if (key === assistantIdemKey("r2", Number(n))) return assistant(Number(n));
        }
        return log.eventLog.findByIdem(conversationId, key);
      },
    };
    return new RecordedToolPipeline({
      // biome-ignore lint/suspicious/noExplicitAny: append / findByIdem / latestOfType only
      eventLog: eventLog as any,
      recordings,
      beforeStep: async () => "continue",
    });
  }

  it("a recorded level is copied by the replay, all its fields", async () => {
    const level = { tier: "dev", isolation: "sandbox", network: "none", unattended: true } as const;
    const s = snap();
    (s.events[2] as { payload: unknown }).payload = { roots: ROOTS, ...level };
    const recordings = recordedCalls(s);
    expect(recordings[0]?.devicePaths).toEqual({ roots: ROOTS, ...level });
    const log = memLog();
    await pipelineFor(recordings, log, { 1: ["f"] }).runStep({
      conversationId: "e",
      runId: "r2",
      step: 1,
    } as never);
    expect(log.appended[0]).toMatchObject({
      type: "device_paths",
      payload: { roots: ROOTS, ...level },
    });
  });

  it("a replayed call that matched copies the recorded device_paths event, never twice", async () => {
    const recordings = recordedCalls(snap());
    expect(recordings[0]?.devicePaths).toEqual({ roots: ROOTS });
    const log = memLog();
    // the candidate makes the recorded call twice in one step: one line
    await pipelineFor(recordings, log, { 1: ["f", "f"] }).runStep({
      conversationId: "e",
      runId: "r2",
      step: 1,
    } as never);
    const types = log.appended.map((e) => e.type);
    expect(types).toEqual([
      "device_paths",
      "tool_call_started",
      "tool_result",
      "tool_call_started",
      "tool_result",
    ]);
    expect(log.appended[0]).toMatchObject({ runId: "r2", payload: { roots: ROOTS } });
  });

  it("calls of later steps are marked too: a candidate whose first sandbox call comes later still gets the line", async () => {
    const s = snap();
    let seq = s.events.length + 1;
    const ev = (type: string, payload: unknown) =>
      s.events.push({ seq: seq++, type, payload, runId: "r", createdAt: "" } as never);
    ev("assistant_message", {
      step: 2,
      stopReason: "tool_use",
      content: [{ type: "tool_call", id: "c1", name: "Write", input: { file_path: "g" } }],
    });
    ev("tool_call_started", { step: 2, callId: "c1", toolKey: "Write", specHash: "h" });
    ev("tool_result", { step: 2, callId: "c1", toolKey: "Write", content: "ok", isError: false });
    const recordings = recordedCalls(s);
    expect(recordings.map((r) => r.devicePaths)).toEqual([{ roots: ROOTS }, { roots: ROOTS }]);
    const log = memLog();
    // the candidate skips the first call and makes the second in its own step 1
    await pipelineFor(recordings, log, { 1: ["g"] }).runStep({
      conversationId: "e",
      runId: "r2",
      step: 1,
    } as never);
    expect(log.appended.map((e) => e.type)).toEqual([
      "device_paths",
      "tool_call_started",
      "tool_result",
    ]);
  });
});

describe("device_paths: a migrated row", () => {
  it("a migrated device_paths row renders one deterministic system line in build and replay", () => {
    const log = new Log();
    log.user("write a file");
    log.modelCall(1, 1);
    log.assistant(
      [{ type: "tool_call", id: "call-1", name: "Write", input: { file_path: "x" } }],
      "tool_use",
      1,
    );
    // the row as migration 0105 leaves it: only the type name differs from the old log
    log.add({ type: "device_paths", payload: { roots: ROOTS } });
    log.add({
      type: "tool_result",
      payload: { step: 1, callId: "call-1", toolKey: "Write", content: "ok", isError: false },
    });
    const input = { events: log.events, agent: AGENT, agentVersion: 1, model: MODEL, step: 2 };
    const first = buildModelRequest(input).request.messages;
    const again = buildModelRequest(input).request.messages;
    expect(first.at(-1)).toEqual({ role: "system", content: LINE });
    expect(again).toEqual(first);
    expect(LINE).not.toMatch(/environment/i);
  });
});

describe("device_paths: the sandbox level (sandbox dev tiers spec §11.5)", () => {
  const DEV_LINE =
    "Sandbox level: development. Package registries and common developer hosts are reachable; other domains need the user's approval. Local servers and unix sockets work.";

  it("each tier and an unsandboxed device have one English line", () => {
    expect(sandboxLevelText({ tier: "dev", isolation: "sandbox" })).toBe(DEV_LINE);
    expect(sandboxLevelText({ tier: "strict", isolation: "sandbox" })).toBe(
      "Sandbox level: strict. Only the organization's allowed domains are reachable; other domains need the user's approval.",
    );
    expect(sandboxLevelText({ tier: "open", isolation: "sandbox" })).toBe(
      "Sandbox level: open. Any public address is reachable. Local servers and unix sockets work.",
    );
    expect(sandboxLevelText({ tier: "open", isolation: "none" })).toMatch(
      /^Sandbox level: open, without a sandbox\. Commands run directly on the user's computer/,
    );
    expect(devicePathsText({ roots: ROOTS, tier: "dev", isolation: "sandbox" })).toBe(
      `${LINE}\n${DEV_LINE}`,
    );
  });

  it("says when the network is off, a scheduled run cannot ask, and what a local machine allows", () => {
    expect(sandboxLevelText({ tier: "dev", isolation: "sandbox", network: "none" })).toBe(
      "Sandbox level: development. The network is switched off for this organization: no domain is reachable and approval requests cannot change that.",
    );
    // without a sandbox, the user's own network: the switch does not apply
    expect(sandboxLevelText({ tier: "open", isolation: "none", network: "none" })).toMatch(
      /^Sandbox level: open, without a sandbox\./,
    );
    expect(sandboxLevelText({ tier: "strict", isolation: "sandbox", unattended: true })).toBe(
      "Sandbox level: strict. Only the organization's allowed domains are reachable; approvals are not available in a scheduled run, so other domains stay blocked.",
    );
    expect(
      sandboxLevelText({
        tier: "dev",
        isolation: "sandbox",
        localhost: "off-proxy-detected",
        unixSockets: "roots",
        unattended: true,
      }),
    ).toBe(
      "Sandbox level: development. Package registries and common developer hosts are reachable; approvals are not available in a scheduled run, so other domains stay blocked. Local servers are blocked on this machine because a local proxy was detected (the user can allow them on the device); unix sockets work under the device's directories only.",
    );
    expect(
      sandboxLevelText({ tier: "open", isolation: "sandbox", localhost: "on", unixSockets: "off" }),
    ).toBe(
      "Sandbox level: open. Any public address is reachable. Local servers work; unix sockets are blocked.",
    );
  });

  it("a change of the network or the local facts records a new event", async () => {
    const t = memTools(ROOTS, { tier: "dev", isolation: "sandbox" });
    const write = () =>
      t
        .tool("Write")
        .run({ file_path: `${ROOTS.workspace}/x-${Math.random()}`, content: "x" }, t.ctx);
    await write();
    t.setLevel({ tier: "dev", isolation: "sandbox", network: "none" });
    await write();
    await write();
    t.setLevel({ tier: "dev", isolation: "sandbox", localhost: "on", unixSockets: "roots" });
    await write();
    const paths = t.log.appended.filter((e) => e.type === "device_paths");
    expect(paths.map((e) => e.payload)).toEqual([
      { roots: ROOTS, tier: "dev", isolation: "sandbox" },
      { roots: ROOTS, tier: "dev", isolation: "sandbox", network: "none" },
      { roots: ROOTS, tier: "dev", isolation: "sandbox", localhost: "on", unixSockets: "roots" },
    ]);
    expect(new Set(paths.map((e) => e.idemKey)).size).toBe(3);
  });

  it("is recorded with the roots on the first call and again when the tier or isolation changes", async () => {
    const t = memTools(ROOTS, { tier: "dev", isolation: "sandbox" });
    const write = () =>
      t
        .tool("Write")
        .run({ file_path: `${ROOTS.workspace}/x-${Math.random()}`, content: "x" }, t.ctx);
    await write();
    await write();
    t.setLevel({ tier: "open", isolation: "sandbox" });
    await write();
    t.setLevel({ tier: "open", isolation: "none" });
    await write();
    await write();
    t.setLevel({ tier: "dev", isolation: "sandbox" });
    await write();
    const paths = t.log.appended.filter((e) => e.type === "device_paths");
    expect(paths.map((e) => e.payload)).toEqual([
      { roots: ROOTS, tier: "dev", isolation: "sandbox" },
      { roots: ROOTS, tier: "open", isolation: "sandbox" },
      { roots: ROOTS, tier: "open", isolation: "none" },
      { roots: ROOTS, tier: "dev", isolation: "sandbox" },
    ]);
    expect(new Set(paths.map((e) => e.idemKey)).size).toBe(4);
  });

  it("a conversation whose latest event predates tiers gets one new event with the level", async () => {
    const t = memTools(ROOTS, { tier: "dev", isolation: "sandbox" });
    await t.log.eventLog.append("c", [
      { type: "device_paths", idemKey: "device_paths:old:0", payload: { roots: ROOTS } },
    ]);
    await t.tool("Write").run({ file_path: `${ROOTS.workspace}/a`, content: "a" }, t.ctx);
    await t.tool("Write").run({ file_path: `${ROOTS.workspace}/b`, content: "b" }, t.ctx);
    const paths = t.log.appended.filter((e) => e.type === "device_paths");
    expect(paths.map((e) => e.payload)).toEqual([
      { roots: ROOTS },
      { roots: ROOTS, tier: "dev", isolation: "sandbox" },
    ]);
  });

  it("an unknown level (no device row) records the roots only, as before tiers", async () => {
    const t = memTools(ROOTS, null);
    await t.tool("Write").run({ file_path: `${ROOTS.workspace}/a`, content: "a" }, t.ctx);
    const paths = t.log.appended.filter((e) => e.type === "device_paths");
    expect(paths.map((e) => e.payload)).toEqual([{ roots: ROOTS }]);
  });

  it("renders the level line after the roots at the event's position; a replay copies the level", async () => {
    const log = new Log();
    log.user("write a file");
    log.modelCall(1, 1);
    log.assistant(
      [{ type: "tool_call", id: "call-1", name: "Write", input: { file_path: "x" } }],
      "tool_use",
      1,
    );
    log.add({ type: "device_paths", payload: { roots: ROOTS, tier: "dev", isolation: "sandbox" } });
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
    expect(request.messages.at(-1)).toEqual({ role: "system", content: `${LINE}\n${DEV_LINE}` });
  });
});
