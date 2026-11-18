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
import { statusLine } from "../../src/tools/builtins/sandbox/task-output.js";

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
];

/**
 * Files still allowed to mention the SID protocol, each with the task that removes it. Remove an
 * entry with that removal; the test then holds for the whole kernel.
 */
const PENDING: Record<string, string> = {
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
    await expect(
      tool.run({ command: "sleep 1", run_in_background: true }, ctx),
    ).rejects.toBeInstanceOf(ToolError);
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
