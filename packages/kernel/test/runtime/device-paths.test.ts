import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { AppendEvent } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { RecordedToolPipeline, recordedCalls } from "../../src/evals/recorded-tools.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import {
  type DeviceModeLevel,
  type DevicePathsPayload,
  devicePathsText,
  modeLevelText,
} from "../../src/runtime/context/device-paths.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { AGENT, compactionSettings, Log, MODEL, NO_TAIL_LIMIT } from "./context/fixtures.js";

/**
 * Devices, local phase (environments spec §13.1, ruling R22): a `device_paths` event in the log
 * (written by the managed device context writer, managed-device-context.test.ts; events of the
 * earlier writer stay in logs) is rendered as a system line, kept through compaction and copied
 * by a full-run replay.
 */

const ROOTS: SandboxRoots = {
  workspace: "/Users/u/capybara-device/e1/workspace",
  skills: "/Users/u/capybara-device/e1/skills",
  tmp: "/Users/u/capybara-device/e1/tmp",
};

const LINE =
  "This device's directories: workspace /Users/u/capybara-device/e1/workspace, skills /Users/u/capybara-device/e1/skills (read only), temporary files /Users/u/capybara-device/e1/tmp. Use these paths in commands and tool calls.";

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

describe("device_paths: rendered for the model", () => {
  it("a recorded device_paths event is rendered as a system line", () => {
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
    expect(devicePathsText({ roots: DEFAULT_SANDBOX_ROOTS })).toBe(
      "This device's directories: workspace /workspace, skills /skills (read only), temporary files /tmp. Use these paths in commands and tool calls.",
    );
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
    const plan = compactionPlan(
      log.events,
      compactionSettings({ keepRecentTurns: 1 }),
      NO_TAIL_LIMIT,
    );
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
    const level = {
      mode: "sandbox",
      allowedMode: "auto",
      network: { kind: "allowlist", hosts: ["a.com"] },
      local: true,
    } as const;
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

  it("a recorded pre-auto-mode level is copied by the replay, all its fields", async () => {
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
    // the old line is rendered exactly as the original model saw it
    expect(devicePathsText(log.appended[0]?.payload as DevicePathsPayload)).toContain(
      "Sandbox level: development.",
    );
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

describe("device_paths: the mode and network (auto mode spec §4.2)", () => {
  const AUTO_LOCAL: DeviceModeLevel = {
    mode: "auto",
    allowedMode: "auto",
    network: { kind: "allowlist", hosts: ["a.com"] },
    local: true,
  };
  const SANDBOX_LOCAL: DeviceModeLevel = {
    mode: "sandbox",
    allowedMode: "auto",
    network: { kind: "allowlist", hosts: ["a.com"] },
    local: true,
  };
  const CLOUD_OPEN: DeviceModeLevel = {
    mode: "auto",
    allowedMode: "auto",
    network: { kind: "open-public", hosts: [] },
    local: false,
  };
  const CLOUD_ALLOWLIST: DeviceModeLevel = {
    mode: "sandbox",
    allowedMode: "sandbox",
    network: { kind: "allowlist", hosts: ["a.com"] },
    local: false,
  };
  const AUTO_LINE =
    "Mode: auto. Commands run as the user on this machine, with their files, credentials and network; every command is reviewed and dangerous ones are blocked or need approval.";
  const SANDBOX_LINE =
    "Mode: sandbox. Only the workspace, skills and temporary files are writable; the network reaches the allowed hosts.";
  const CLOUD_OPEN_LINE =
    "Mode: auto. Commands run in the device's container; outside it only public addresses are reachable (loopback, private and cloud metadata addresses are blocked).";
  const CLOUD_ALLOWLIST_LINE =
    "Mode: sandbox. Commands run in the device's container; outside it the network reaches the organization's allowlisted hosts.";

  it("each mode and network has one English line", () => {
    expect(modeLevelText(AUTO_LOCAL)).toBe(AUTO_LINE);
    expect(modeLevelText(SANDBOX_LOCAL)).toBe(SANDBOX_LINE);
    expect(modeLevelText(CLOUD_OPEN)).toBe(CLOUD_OPEN_LINE);
    expect(modeLevelText(CLOUD_ALLOWLIST)).toBe(CLOUD_ALLOWLIST_LINE);
    expect(devicePathsText({ roots: ROOTS, ...AUTO_LOCAL })).toBe(`${LINE}\n${AUTO_LINE}`);
  });

  it("an event recorded before auto mode renders exactly as it always did", () => {
    expect(devicePathsText({ roots: ROOTS, tier: "dev", isolation: "sandbox" })).toBe(
      `${LINE}\nSandbox level: development. Package registries and common developer hosts are reachable; other domains need the user's approval. Local servers and unix sockets work.`,
    );
    expect(devicePathsText({ roots: ROOTS, tier: "open", isolation: "none" })).toMatch(
      /^This device's directories: .*\nSandbox level: open, without a sandbox\./,
    );
  });

  it("renders the mode line after the roots at the event's position; a replay copies the level", () => {
    const log = new Log();
    log.user("write a file");
    log.modelCall(1, 1);
    log.assistant(
      [{ type: "tool_call", id: "call-1", name: "Write", input: { file_path: "x" } }],
      "tool_use",
      1,
    );
    log.add({ type: "device_paths", payload: { roots: ROOTS, ...AUTO_LOCAL } });
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
    expect(request.messages.at(-1)).toEqual({ role: "system", content: `${LINE}\n${AUTO_LINE}` });
  });
});
