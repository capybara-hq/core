import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { newTaskId } from "../../src/background/launch.js";
import { BackgroundTaskStopper } from "../../src/background/stop.js";
import type { BackgroundTaskRow } from "../../src/background/store.js";
import { launchRefusedText } from "../../src/sandbox/operation-intents.js";
import { RetirementPendingError } from "../../src/sandbox/sandbox.service.js";
import { sandboxBashTool } from "../../src/tools/builtins/sandbox/bash.js";
import { taskListTool } from "../../src/tools/builtins/sandbox/task-list.js";
import { statusLine, taskOutputTool } from "../../src/tools/builtins/sandbox/task-output.js";
import { taskStopTool } from "../../src/tools/builtins/sandbox/task-stop.js";

/*
 * The kernel background legacy removal (permission activation W5-P2): no code path builds a SID
 * launch, poll, term, kill or tail script any more; a legacy row is only ever left to the
 * retirement gate (`retire-legacy-tasks.job.ts`), and poll, stop and output act by exact refs only.
 * Launch failures are told in the kernel's own actionable words, never raw provider text.
 */

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/** Every TypeScript file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

/** The shell tools and builders of the SID protocol (launch, poll, term, kill, tail). */
const SID_MARKERS = [
  /\bsetsid\b/,
  /\bpkill\b/,
  /\bpgrep\b/,
  /\btk_kill\b/,
  /\btk_alive\b/,
  /\bGROUP_LAUNCHER\b/,
  /\blaunchScript\b/,
  /\bpollScript\b/,
  /\btermScript\b/,
  /\bkillSessionScript\b/,
  /\bkillSession\b/,
  /\btaskReadScript\b/,
  /\btailCommand\b/,
  /\btaskSidPath\b/,
  /\bSESSION_MODE_SCRIPT\b/,
];

/**
 * Files still allowed to mention the SID protocol, each with the task that removes it. Remove an
 * entry with that removal; the test then holds for the whole kernel.
 */
const PENDING: Record<string, string> = {
  // re-exports SESSION_MODE_SCRIPT for sandbox.service.ts only; the re-export goes with W5-P3a
  "background/launch.ts": "W5-P3a",
  // W5-P3a removes the SID cleanup on resume and rebuild (its only user of the fragment below)
  "sandbox/sandbox.service.ts": "W5-P3a",
  "background/legacy-session-mode.ts": "W5-P3a",
};

/**
 * Files that name these programs without building any script: the command review classifies a
 * person's or model's own command that runs them (`pkill`, `setsid` as a prefix, `pgrep`).
 */
const NOT_A_BUILDER: Record<string, string> = {
  "sandbox/review/rules.ts": "command review rules",
};

describe("no SID script is built anywhere in the kernel", () => {
  it("no source file outside the pending list names a SID shell tool or builder", () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel in PENDING) continue;
      if (rel in NOT_A_BUILDER) {
        // only the program names: never a builder or a SID shell function
        const text = readFileSync(file, "utf8");
        for (const m of SID_MARKERS.slice(3)) if (m.test(text)) hits.push(`${rel}: ${m.source}`);
        continue;
      }
      const text = readFileSync(file, "utf8");
      for (const m of SID_MARKERS) if (m.test(text)) hits.push(`${rel}: ${m.source}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("newTaskId", () => {
  it("is bt_ plus 6 lowercase base32 characters, different each time", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTaskId()));
    for (const id of ids) expect(id).toMatch(/^bt_[a-z2-7]{6}$/);
    expect(ids.size).toBeGreaterThan(45);
  });
});

describe("Bash run_in_background without the managed route", () => {
  it("reserves nothing and runs no exec: there is no legacy launch left", async () => {
    const exec = vi.fn();
    const reserve = vi.fn(async () => true);
    const withSandbox = vi.fn();
    const tool = sandboxBashTool({
      sandbox: {
        cloudAvailable: true,
        availableFor: async () => true,
        withSandbox,
        currentInstance: async () => ({ provider: "p", createdAt: new Date(1) }),
      },
      devices: { forTool: async () => "00000000-0000-4000-8000-000000000003" },
      background: { reserve, get: async () => undefined } as never,
      attachments: {} as never,
      storage: {} as never,
      eventLog: {} as never,
      config: {
        get: () =>
          ({
            sandbox: {
              background: { maxSeconds: 60, maxTasks: 4 },
              limits: { maxCommandSeconds: 60 },
              lockWaitSeconds: 1,
            },
            tools: { outputRetentionDays: 1 },
          }) as never,
      },
    } as never);
    const ctx = {
      orgId: "00000000-0000-4000-8000-000000000001",
      conversationId: "00000000-0000-4000-8000-000000000004",
      accountId: "00000000-0000-4000-8000-000000000002",
      runId: "00000000-0000-4000-8000-000000000005",
      callId: "c1",
      signal: new AbortController().signal,
    } as never;
    // the managed launch's own precondition (no managed store, no execution claim)
    await expect(tool.run({ command: "sleep 1", run_in_background: true }, ctx)).rejects.toThrow(
      new ToolError(
        "Background tasks are not available here; call Bash without run_in_background.",
      ),
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(withSandbox).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("launch failures are actionable kernel text", () => {
  it("an unclassified refusal says what to do next", () => {
    const text = launchRefusedText(undefined);
    expect(text).toMatch(/retry/i);
    expect(text).toMatch(/device/);
  });

  it("a legacy launch failure's recorded raw reason is never shown to the model", () => {
    const task = {
      id: "bt_aaaaaa",
      status: "failed",
      launchState: "legacy",
      lostReason: "launch failed: sh: 1: setsid: not found",
      exitCode: null,
      startedAt: new Date(0),
      finishedAt: new Date(2000),
    } as unknown as BackgroundTaskRow;
    const line = statusLine(task);
    expect(line).not.toContain("setsid");
    expect(line).not.toContain("not found");
    expect(line).toMatch(/^Status: failed \(.+\) after 2s$/);
    expect(line).toMatch(/Bash/);
  });
});

describe("a legacy task's stop acts by no SID", () => {
  const task = {
    id: "bt_aaaaaa",
    deviceId: "00000000-0000-4000-8000-000000000003",
    sid: "42",
    status: "running",
    launchState: "legacy",
    sandboxCreatedAt: new Date(1000),
    conversationId: "00000000-0000-4000-8000-000000000004",
    sandboxConversationId: "00000000-0000-4000-8000-000000000004",
    triggerAccountId: "00000000-0000-4000-8000-000000000002",
    deadlineAt: new Date(1e13),
  } as unknown as BackgroundTaskRow;

  it("whatever a caller passes as the old gate seam, its running instance gets no exec", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "term", stderr: "" }));
    const ifRunning = vi.fn(async (...a: unknown[]) => {
      const fn = a[2] as (p: unknown, h: unknown, s: AbortSignal) => Promise<unknown>;
      return { kind: "ran", value: await fn({ exec }, { id: "h1" }, new AbortController().signal) };
    });
    const store = {
      claimStop: vi.fn(async () => true),
      releaseStop: vi.fn(async () => {}),
      get: vi.fn(async () => task),
    };
    const finisher = { finish: vi.fn(async () => true) };
    // the removed activation parameter: `false` used to select the SID stop
    const Stopper = BackgroundTaskStopper as unknown as new (
      ...a: unknown[]
    ) => BackgroundTaskStopper;
    const stopper = new Stopper(store, finisher, { ifRunning }, {}, { warn: vi.fn() }, false);
    await expect(stopper.stop(task, "person")).rejects.toBeInstanceOf(RetirementPendingError);
    expect(exec).not.toHaveBeenCalled();
    expect(store.releaseStop).toHaveBeenCalledTimes(1);
    expect(finisher.finish).not.toHaveBeenCalled();
  });
});

const ORG = "00000000-0000-4000-8000-000000000001";
const CONV = "00000000-0000-4000-8000-000000000004";
const DEV = "00000000-0000-4000-8000-000000000003";

/** A legacy task row of the conversation (started in instance 1000 unless overridden). */
const legacyTask = (over: Partial<BackgroundTaskRow> = {}): BackgroundTaskRow =>
  ({
    id: "bt_aaaaaa",
    orgId: ORG,
    conversationId: CONV,
    sandboxConversationId: CONV,
    deviceId: DEV,
    description: "Serve",
    command: "serve",
    sid: "42",
    outputPath: "/workspace/.capybara/tasks/bt_aaaaaa.out",
    status: "running",
    lostReason: null,
    exitCode: null,
    startedAt: new Date(0),
    finishedAt: null,
    deadlineAt: new Date(1e13),
    sandboxCreatedAt: new Date(1000),
    launchState: "legacy",
    executionRef: null,
    readOffset: 0,
    ...over,
  }) as unknown as BackgroundTaskRow;

/** The task tools on fakes: `ifRunning` answers `answer` (or runs its callback with `ran`). */
function taskTools(task: BackgroundTaskRow, answer: { kind: string; status?: string }) {
  let row = task;
  const exec = vi.fn();
  const finish = vi.fn(
    async (_t: BackgroundTaskRow, to: Record<string, unknown>, ..._r: unknown[]) => {
      row = { ...row, status: to.status, lostReason: to.lostReason ?? null } as BackgroundTaskRow;
      return true;
    },
  );
  const ifRunning = vi.fn(async (...a: unknown[]) => {
    if (answer.kind !== "ran") return answer;
    const fn = a[2] as (p: unknown, h: unknown, s: AbortSignal) => Promise<unknown>;
    return { kind: "ran", value: await fn({ exec }, { id: "h1" }, new AbortController().signal) };
  });
  const deps = {
    sandbox: {
      cloudAvailable: true,
      availableFor: async () => true,
      withSandbox: vi.fn(),
      ifRunning,
    },
    devices: { forTool: async () => DEV },
    background: {
      get: async () => row,
      runningOwnedBy: async () => (row.status === "running" ? [row] : []),
      finishedOwnedBy: async () =>
        row.status === "running" ? { rows: [], total: 0 } : { rows: [row], total: 1 },
      advanceOffset: vi.fn(),
    },
    tasks: { finisher: { finish }, stopper: { stop: vi.fn() } },
    attachments: {},
    storage: {},
    eventLog: { findByIdem: async () => undefined },
    config: { get: () => ({ tools: { outputSpillChars: 1000 }, sandbox: { lockWaitSeconds: 1 } }) },
  } as never;
  const ctx = {
    orgId: ORG,
    conversationId: CONV,
    accountId: "00000000-0000-4000-8000-000000000002",
    callId: "c1",
    signal: new AbortController().signal,
  } as never;
  return {
    output: taskOutputTool(deps),
    list: taskListTool(deps),
    deps,
    ctx,
    finish,
    exec,
    ifRunning,
  };
}

const textOf = (r: unknown): string =>
  (r as { content: { text: string }[] }).content[0]?.text ?? "";

describe("TaskOutput of a running legacy task", () => {
  for (const [answer, reason] of [
    [{ kind: "not_running", status: "gone" }, "sandbox_gone"],
    [{ kind: "not_running", status: "suspended" }, "sandbox_suspended"],
    [{ kind: "other_instance" }, "sandbox_recreated"],
  ] as const) {
    it(`an instance that is ${answer.status ?? "replaced"} settles the task lost (${reason}), no refusal`, async () => {
      const t = taskTools(legacyTask(), answer);
      const r = await t.output.run({ task_id: "bt_aaaaaa", block: false }, t.ctx);
      expect(t.finish).toHaveBeenCalledTimes(1);
      expect(t.finish.mock.calls[0]?.[1]).toMatchObject({ status: "lost", lostReason: reason });
      // reported: this call's result tells the model
      expect(t.finish.mock.calls[0]?.[3]).toBe(true);
      expect(textOf(r)).toMatch(/^Status: lost \(/);
      expect(textOf(r)).not.toContain("not been confirmed destroyed");
      expect(t.exec).not.toHaveBeenCalled();
    });
  }

  it("an instance that really runs is refused with the retirement text, with no exec", async () => {
    const t = taskTools(legacyTask(), { kind: "ran" });
    await expect(t.output.run({ task_id: "bt_aaaaaa", block: false }, t.ctx)).rejects.toThrow(
      /background work started by an earlier version may still run/,
    );
    expect(t.finish).not.toHaveBeenCalled();
    expect(t.exec).not.toHaveBeenCalled();
  });
});

describe("TaskStop of a running legacy task", () => {
  it("a refused stop says the retirement gate's own text", async () => {
    const t = taskTools(legacyTask(), { kind: "ran" });
    const stopper = new BackgroundTaskStopper(
      {
        claimStop: async () => true,
        releaseStop: async () => {},
        get: async () => legacyTask(),
      } as never,
      { finish: vi.fn() } as never,
      { ifRunning: t.ifRunning } as never,
      {} as never,
      { warn: vi.fn() },
    );
    const tool = taskStopTool({
      ...(t.deps as object),
      tasks: { finisher: { finish: vi.fn() }, stopper },
    } as never);
    await expect(tool.run({ task_id: "bt_aaaaaa" }, t.ctx)).rejects.toThrow(
      /background work started by an earlier version may still run/,
    );
    expect(t.exec).not.toHaveBeenCalled();
  });
});

describe("TaskList reasons", () => {
  it("a legacy failed launch is listed in the kernel's actionable words, never its raw stderr", async () => {
    const t = taskTools(
      legacyTask({
        status: "failed",
        lostReason: "launch failed: sh: 1: setsid: not found",
        sandboxCreatedAt: null,
        finishedAt: new Date(2000),
      }),
      { kind: "ran" },
    );
    const text = textOf(await t.list.run({ status: "all" }, t.ctx));
    expect(text).not.toContain("setsid");
    expect(text).toContain("call Bash with run_in_background again");
  });
});
