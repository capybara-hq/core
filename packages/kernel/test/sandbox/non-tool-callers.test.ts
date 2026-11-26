import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskPollJob } from "../../src/background/poll.job.js";
import { BackgroundTaskStopper } from "../../src/background/stop.js";
import type { BackgroundTaskRow } from "../../src/background/store.js";
import { BackgroundTasks } from "../../src/background/tasks.service.js";
import { DeviceProjectsService } from "../../src/devices/device-projects.service.js";
import { ApiError } from "../../src/errors.js";
import { ProjectKnowledgeService } from "../../src/runtime/project/knowledge.service.js";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import { RetirementPendingError } from "../../src/sandbox/sandbox.service.js";
import { SandboxFileReader } from "../../src/sandbox/sandbox-file-reader.js";
import { SkillInvoker } from "../../src/skills/invoke.js";

/*
 * The non-tool callers of a device (permission activation W3-L, L2): owner project browsing
 * starts the device for its owner (`ensureRunningForOwner`) and goes through `withBrowse`,
 * run-start knowledge reads through `withKernelRead` and the kernel's file read through
 * `withOperations` under the run's execution claim, a person's project skill invocation renders a
 * stub without any device call, and background reads, stops and polls of a legacy (SID) task
 * never run any exec (the SID path is gone, W5-P2). Real admission of these routes is covered by
 * `kernel-reads.test.ts`.
 */

const claim: { current: ExecutionClaim | undefined } = { current: undefined };
vi.mock("../../src/runtime/run-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/runtime/run-execution.js")>()),
  currentExecutionClaim: () => claim.current,
}));
vi.mock("../../src/runtime/subagents/child.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/runtime/subagents/child.js")>()),
  rootConversationOf: async (_db: unknown, id: string) => id,
}));
vi.mock("../../src/conversations/tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/conversations/tree.js")>()),
  conversationTree: async (_db: unknown, id: string) => [{ id }],
}));

const ORG = "00000000-0000-4000-8000-000000000001";
const ACC = "00000000-0000-4000-8000-000000000002";
const DEV = "00000000-0000-4000-8000-000000000003";
const CONV = "00000000-0000-4000-8000-000000000004";
const RUN = "00000000-0000-4000-8000-000000000005";
const WS = "/workspace";
const ROOTS = { workspace: WS, skills: "/skills", tmp: "/tmp" };
const H = { id: "h1" };

/** A query builder that answers every chain with `first` / `all`. */
function fakeDb(first?: unknown, all: unknown[] = []): never {
  const chain: unknown = new Proxy(() => {}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "db") return chain;
      if (k === "execute") return async () => all;
      if (k === "executeTakeFirst" || k === "executeTakeFirstOrThrow") return async () => first;
      return () => chain;
    },
    apply: () => chain,
  });
  return chain as never;
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

/** A sandbox service whose every entry is a spy; the held provider answers from `files`. */
function fakeSandbox() {
  const held = {
    stat: vi.fn(async () => ({ size: 3, isDir: false })),
    readFile: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), truncated: false })),
    list: vi.fn(async () => null),
    scan: vi.fn(async () => [{ path: `${WS}/app`, suggestedName: "app" }]),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
  const browse = {
    stat: vi.fn(async () => ({ size: 0, isDir: false })),
    list: vi.fn(async () => null),
    scan: vi.fn(async () => [{ path: `${WS}/app`, suggestedName: "app" }]),
  };
  const info = { roots: ROOTS, fresh: false, restarted: false };
  const run = (fn: (...a: never[]) => unknown) =>
    (fn as (...a: unknown[]) => unknown)(H, held, info, new AbortController().signal);
  const sandbox = {
    held,
    browse,
    withOperations: vi.fn(async (_ctx: unknown, _inv: unknown, fn: never) => run(fn)),
    withKernelRead: vi.fn(async (_ctx: unknown, _read: unknown, fn: never) => run(fn)),
    ensureRunningForOwner: vi.fn(async (_ctx: unknown, _signal?: AbortSignal) => {}),
    withBrowse: vi.fn(async (_ctx: unknown, fn: never) =>
      (fn as (...a: unknown[]) => unknown)(browse, new AbortController().signal),
    ),
    ifRunning: vi.fn(
      async (..._a: unknown[]): Promise<{ kind: string; status?: string; value?: unknown }> => ({
        kind: "not_running",
        status: "suspended",
      }),
    ),
    availableFor: vi.fn(async () => true),
  };
  return sandbox;
}

let sb: ReturnType<typeof fakeSandbox>;
beforeEach(() => {
  sb = fakeSandbox();
  claim.current = undefined;
});

describe("device projects (owner browse)", () => {
  // a provider that reports no home: projects stay in the workspace
  const scope = {
    mode: "sandbox" as const,
    workspace: WS,
    home: null,
    supported: true,
  };
  const projects = (log = { warn: () => {} }) =>
    new DeviceProjectsService(
      fakeDb(undefined, []),
      {} as never,
      sb as never,
      { usable: async () => {} } as never,
      { projectScope: async () => scope } as never,
      {} as never,
      log,
    );

  it("a device that cannot be asked answers generically and logs the cause", async () => {
    const refusal = new Error("Earlier work on this device is not settled (3)");
    sb.ensureRunningForOwner.mockRejectedValueOnce(refusal);
    const warn = vi.fn();
    await expect(projects({ warn }).candidates(ORG, ACC, DEV)).rejects.toMatchObject({
      code: "device.projects_unavailable",
      message: "The device could not be asked now; try again shortly",
    });
    expect(warn).toHaveBeenCalledWith(expect.any(String), { deviceId: DEV, err: refusal });
  });

  it("candidates start the device for its owner, then scan through withBrowse", async () => {
    const got = await projects().candidates(ORG, ACC, DEV);
    expect(sb.ensureRunningForOwner).toHaveBeenCalledTimes(1);
    expect(sb.ensureRunningForOwner.mock.calls[0]?.[0]).toEqual({
      orgId: ORG,
      deviceId: DEV,
      accountId: ACC,
    });
    expect(sb.ensureRunningForOwner.mock.invocationCallOrder[0]).toBeLessThan(
      sb.withBrowse.mock.invocationCallOrder[0] as number,
    );
    expect(sb.withBrowse).toHaveBeenCalledTimes(1);
    expect(sb.withBrowse.mock.calls[0]?.[0]).toEqual({ orgId: ORG, deviceId: DEV, accountId: ACC });
    expect(sb.browse.scan).toHaveBeenCalledWith(WS, expect.objectContaining({}));
    expect(got.candidates).toEqual([
      { path: `${WS}/app`, relativePath: "app", suggestedName: "app" },
    ]);
  });

  it("add lists and stats through withBrowse; a missing path is refused", async () => {
    await expect(projects().add(ORG, ACC, DEV, { path: "app" })).rejects.toMatchObject({
      code: "device.project_path_missing",
    });
    expect(sb.browse.list).toHaveBeenCalledWith(`${WS}/app`, expect.objectContaining({ limit: 1 }));
  });

  it("a browse scope denial of the path is the device refusing it in its mode", async () => {
    sb.browse.list.mockRejectedValueOnce(new SandboxScopeDeniedError("outside"));
    await expect(projects().add(ORG, ACC, DEV, { path: "app" })).rejects.toMatchObject({
      code: "device.project_outside_mode",
    });
  });
});

describe("project knowledge (run start)", () => {
  const knowledge = () =>
    new ProjectKnowledgeService(
      fakeDb({ trigger_account_id: ACC }),
      {} as never,
      {} as never,
      { forTool: async () => DEV } as never,
      {
        keeps: async () => true,
        scopeFor: async () => ({
          mode: "sandbox",
          workspace: WS,
          home: null,
          supported: true,
        }),
      } as never,
      sb as never,
      log,
    );
  const read = (s: ProjectKnowledgeService) =>
    (s as unknown as { read: (...a: unknown[]) => Promise<unknown> }).read(
      {
        orgId: ORG,
        conversationId: CONV,
        runId: RUN,
        kind: "chat",
        signal: new AbortController().signal,
      },
      { accountId: ACC, project: "app", root: `${WS}/app` },
    );

  it("reads through withKernelRead under the run's execution claim", async () => {
    claim.current = {
      runId: RUN,
      conversationId: CONV,
      orgId: ORG,
      rootId: CONV,
      executionId: "e1",
    };
    const got = await read(knowledge());
    expect(sb.withOperations).not.toHaveBeenCalled();
    expect(sb.withKernelRead).toHaveBeenCalledTimes(1);
    const [ctx, kernelRead] = sb.withKernelRead.mock.calls[0] as unknown as [
      { holderConversationId: string; actor: { runId: string; accountId: string } },
      { claim: ExecutionClaim; purpose: string; root: string },
    ];
    expect(ctx.holderConversationId).toBe(CONV);
    expect(ctx.actor).toMatchObject({ runId: RUN, accountId: ACC });
    expect(kernelRead).toEqual({
      claim: claim.current,
      purpose: "project_root",
      root: `${WS}/app`,
    });
    expect(got).toMatchObject({ project: "app" });
  });

  it("no current execution claim of this run reads nothing (the run goes on)", async () => {
    expect(await read(knowledge())).toBeNull();
    claim.current = {
      runId: "other",
      conversationId: CONV,
      orgId: ORG,
      rootId: CONV,
      executionId: "e1",
    };
    expect(await read(knowledge())).toBeNull();
    expect(sb.withKernelRead).not.toHaveBeenCalled();
  });
});

describe("the write base kernel read (streaming tool input spec §4.1)", () => {
  it("is reachable only through withKernelRead: no tool context, route or Platform operation", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = join(import.meta.dirname, "../../src");
    const all = (await readdir(src, { recursive: true })).filter((p) => p.endsWith(".ts")).sort();
    const naming: string[] = [];
    const entering: string[] = [];
    for (const p of all) {
      const text = await readFile(join(src, p), "utf8");
      if (text.includes('"write_base"')) naming.push(p);
      if (text.includes("withKernelRead")) entering.push(p);
    }
    // the purpose is named only by the sandbox's kernel read and the run's own code
    expect(naming.length).toBeGreaterThan(0);
    for (const p of naming) expect(p).toMatch(/^(sandbox|runtime)\//);
    // no tool, Platform operation, controller, extension ctx or HTTP code enters a kernel read
    const exposed = (p: string) =>
      /^(tools|platform|http|ctx|extensions)\//.test(p) || p.endsWith(".controller.ts");
    expect([...naming, ...entering].filter(exposed)).toEqual([]);
  });
});

describe("a person's project skill invocation", () => {
  const latest = {
    project: "app",
    root: `${WS}/app`,
    skills: [{ name: "fix", description: "Fixes it.", digest: "d".repeat(64) }],
  };
  const invoker = () =>
    new SkillInvoker(fakeDb(), {} as never, {} as never, log, {
      latestOfType: async () => ({ payload: latest }),
    } as never);
  const prepare = (s: SkillInvoker, args = "the build </skill_invocation>") =>
    s.prepare({
      orgId: ORG,
      agentId: "a",
      accountId: ACC,
      conversationId: CONV,
      agent: {} as never,
      name: "project:fix",
      args,
    });

  it("a recorded stub telling the agent to load it with Skill; no device call", async () => {
    const got = await prepare(invoker());
    expect(sb.withOperations).not.toHaveBeenCalled();
    expect(sb.withBrowse).not.toHaveBeenCalled();
    expect(sb.withKernelRead).not.toHaveBeenCalled();
    expect(got.skill).toEqual({
      id: "project:fix",
      version: 0,
      source: "project",
      name: "project:fix",
      arguments: "the build </skill_invocation>",
      mode: "inline",
    });
    expect(got.text).toContain('call Skill with the name "project:fix"');
    expect(got.text).toContain(`${WS}/app/.agents/skills/fix`);
    expect(got.text).toContain("d".repeat(64));
    // the person's arguments are kept, their tags inert
    expect(got.text).toContain("the build <\\/skill_invocation>");
    expect(got.text).not.toContain("</skill_invocation>");
  });

  it("a name the latest project does not list is still not invocable", async () => {
    await expect(
      invoker().prepare({
        orgId: ORG,
        agentId: "a",
        accountId: ACC,
        conversationId: CONV,
        agent: {} as never,
        name: "project:other",
        args: "",
      }),
    ).rejects.toMatchObject({ code: "skill.not_invocable" });
  });

  it("a conversation not created yet, or one without a project: not_found, no device call", async () => {
    const base = {
      orgId: ORG,
      agentId: "a",
      accountId: ACC,
      agent: {} as never,
      name: "project:fix",
      args: "",
    };
    // the first message of a conversation not created yet has no project
    await expect(invoker().prepare(base)).rejects.toMatchObject({
      code: "skill.not_invocable",
      details: [{ reason: "not_found" }],
    });
    // a conversation whose log records no project_root
    const free = new SkillInvoker(fakeDb(), {} as never, {} as never, log, {
      latestOfType: async () => undefined,
    } as never);
    await expect(free.prepare({ ...base, conversationId: CONV })).rejects.toMatchObject({
      code: "skill.not_invocable",
      details: [{ reason: "not_found" }],
    });
    expect(sb.withOperations).not.toHaveBeenCalled();
    expect(sb.withKernelRead).not.toHaveBeenCalled();
  });

  it("an agent without the Skill tool is refused, and its menu lists no project skill", async () => {
    const noSkill = { disabledTools: [{ kind: "builtin", name: "Skill" }] };
    await expect(
      invoker().prepare({
        orgId: ORG,
        agentId: "a",
        accountId: ACC,
        conversationId: CONV,
        agent: noSkill as never,
        name: "project:fix",
        args: "",
      }),
    ).rejects.toMatchObject({
      code: "skill.project_unavailable",
      details: [{ reason: "skill_tool_off" }],
    });
    const listing = (definition: unknown = noSkill) =>
      new SkillInvoker(
        fakeDb({ id: CONV }, []),
        {} as never,
        { get: async () => ({ definition }) } as never,
        log,
        { latestOfType: async () => ({ payload: latest }) } as never,
      ).listFor(ORG, "a", ACC, CONV);
    expect((await listing()).map((s) => s.name)).toEqual([]);
    expect((await listing({ disabledTools: [] })).map((s) => s.name)).toEqual(["project:fix"]);
  });
});

describe("the kernel's file read (agents.register-skill)", () => {
  const reader = () =>
    new SandboxFileReader(fakeDb(), { forTool: async () => DEV } as never, sb as never, log);
  const input = {
    orgId: ORG,
    conversationId: CONV,
    actorAccountId: ACC,
    path: `${WS}/pkg.zip`,
    maxBytes: 10,
    signal: new AbortController().signal,
  };

  it("read goes through withOperations with the run's claim and the tool call", async () => {
    claim.current = {
      runId: RUN,
      conversationId: CONV,
      orgId: ORG,
      rootId: CONV,
      executionId: "e1",
    };
    const got = await reader().read({ ...input, callId: "call-1" });
    expect(got).toEqual(new Uint8Array([1, 2, 3]));
    const [ctx, inv] = sb.withOperations.mock.calls[0] as unknown as [
      { actor: { runId: string } },
      { claim: ExecutionClaim; callId: string },
    ];
    expect(ctx.actor.runId).toBe(RUN);
    expect(inv).toMatchObject({ claim: claim.current, callId: "call-1" });
  });

  it("without a claim or a call id nothing is entered", async () => {
    await expect(reader().read({ ...input, callId: "call-1" })).rejects.toBeInstanceOf(Error);
    claim.current = {
      runId: RUN,
      conversationId: CONV,
      orgId: ORG,
      rootId: CONV,
      executionId: "e1",
    };
    await expect(reader().read(input)).rejects.toBeInstanceOf(Error);
    expect(sb.withOperations).not.toHaveBeenCalled();
  });
});

describe("background tasks (HTTP output and stop)", () => {
  const base = {
    id: "bt_aaaaaa",
    orgId: ORG,
    conversationId: CONV,
    sandboxConversationId: CONV,
    deviceId: DEV,
    runId: RUN,
    callId: "c",
    triggerAccountId: ACC,
    description: "d",
    command: "sleep 1",
    sid: "42",
    outputPath: `${WS}/.capybara/tasks/bt_aaaaaa.out`,
    status: "running",
    lostReason: null,
    exitCode: null,
    startedAt: new Date(0),
    finishedAt: null,
    deadlineAt: new Date(1e13),
    sandboxCreatedAt: new Date(1000),
    killPending: false,
    readOffset: 0,
    stoppingAt: null,
    launchState: "legacy",
    operationId: null,
    workingRoot: null,
    retainUntil: null,
    executionRef: null,
    instanceId: null,
    instanceGeneration: null,
    cancelRequestedAt: null,
  } as unknown as BackgroundTaskRow;
  const stopper = { stop: vi.fn(async (t: BackgroundTaskRow) => t) };
  const tasks = (task: BackgroundTaskRow) =>
    new BackgroundTasks(
      { isAccessible: async () => true } as never,
      { get: async () => task, listFor: async () => [task] } as never,
      stopper as never,
      sb as never,
      { findByIdem: async () => undefined } as never,
      fakeDb({ provider: "device-fake" }),
      { forTool: async () => DEV } as never,
    );
  beforeEach(() => stopper.stop.mockClear());

  it("a running legacy task's output is the retirement gate's actionable refusal", async () => {
    await expect(tasks(base).output(ORG, CONV, ACC, base.id, 100)).rejects.toBeInstanceOf(
      RetirementPendingError,
    );
    expect(sb.ifRunning).not.toHaveBeenCalled();
  });

  it("a finished legacy task's output is never read by an exec", async () => {
    const done = { ...base, status: "completed" } as unknown as BackgroundTaskRow;
    await expect(tasks(done).output(ORG, CONV, ACC, base.id, 100)).rejects.toMatchObject({
      code: "background_task.output_unavailable",
    });
    expect(sb.ifRunning).not.toHaveBeenCalled();
  });

  it("a legacy task's stop goes to the stopper, which never signals it", async () => {
    await tasks(base).stop(ORG, CONV, ACC, base.id);
    expect(stopper.stop).toHaveBeenCalledTimes(1);
  });

  it("a managed task reads by its exact ref (an exact-ref drain, no exec)", async () => {
    const managed = {
      ...base,
      sid: null,
      launchState: "acknowledged",
      operationId: "op1",
      instanceId: "h1",
      instanceGeneration: "1000",
      executionRef: {
        executionId: "x1",
        operationId: "op1",
        instanceId: "h1",
        instanceGeneration: "1000",
      },
    } as unknown as BackgroundTaskRow;
    await expect(tasks(managed).output(ORG, CONV, ACC, base.id, 100)).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(sb.ifRunning).toHaveBeenCalledTimes(1);
    expect(sb.ifRunning.mock.calls[0]?.[1]).toEqual({ createdAt: new Date(1000), exactRef: true });
    await tasks(managed)
      .stop(ORG, CONV, ACC, base.id)
      .catch(() => undefined);
    expect(stopper.stop).toHaveBeenCalledTimes(1);
  });

  it("a finished legacy task that never started answers not_started, with no device call", async () => {
    const never = {
      ...base,
      sid: null,
      sandboxCreatedAt: null,
      status: "failed",
    } as unknown as BackgroundTaskRow;
    await expect(tasks(never).output(ORG, CONV, ACC, base.id, 100)).rejects.toMatchObject({
      code: "background_task.output_unavailable",
      details: [{ reason: "not_started", provider: "device-fake" }],
    });
    expect(sb.ifRunning).not.toHaveBeenCalled();
  });
});

describe("the legacy stop and poll (W3-L review M2, M4)", () => {
  const task = {
    id: "bt_aaaaaa",
    deviceId: DEV,
    sid: "42",
    status: "running",
    launchState: "legacy",
    sandboxCreatedAt: new Date(1000),
    conversationId: CONV,
    sandboxConversationId: CONV,
    triggerAccountId: ACC,
    deadlineAt: new Date(1e13),
  } as unknown as BackgroundTaskRow;
  const store = {
    claimStop: vi.fn(async () => true),
    releaseStop: vi.fn(async () => {}),
    get: vi.fn(async () => task),
  };
  const finisher = { finish: vi.fn(async () => true) };
  const stopper = () =>
    new BackgroundTaskStopper(store as never, finisher as never, sb as never, fakeDb(), log);
  /** `ifRunning` that runs its callback on a running instance with the held exec. */
  const running = () =>
    sb.ifRunning.mockImplementation(async (...a: unknown[]) => {
      const fn = a[2] as (p: unknown, h: unknown, s: AbortSignal) => Promise<unknown>;
      return { kind: "ran", value: await fn(sb.held, H, new AbortController().signal) };
    });
  beforeEach(() => {
    store.releaseStop.mockClear();
    finisher.finish.mockClear();
  });

  it("a stop on a running instance refuses before any exec and gives up its claim", async () => {
    running();
    await expect(stopper().stop(task, "person")).rejects.toBeInstanceOf(RetirementPendingError);
    expect(sb.held.exec).not.toHaveBeenCalled();
    expect(store.releaseStop).toHaveBeenCalledTimes(1);
    expect(finisher.finish).not.toHaveBeenCalled();
  });

  it("a stop whose instance is gone finishes without any exec", async () => {
    sb.ifRunning.mockResolvedValueOnce({ kind: "not_running", status: "gone" });
    await stopper().stop(task, "person");
    expect(sb.held.exec).not.toHaveBeenCalled();
    expect(finisher.finish).toHaveBeenCalledTimes(1);
  });

  it("a running legacy instance is left alone, logged once per instance at info", async () => {
    running();
    const info = vi.fn();
    const warn = vi.fn();
    const markers = new Set<string>();
    const redis = {
      set: vi.fn(async (key: string) => {
        const prev = markers.has(key) ? "1" : null;
        markers.add(key);
        return prev;
      }),
    };
    const job = new BackgroundTaskPollJob(
      {
        runningLegacy: async () => [task],
        runningManaged: async () => [],
        owedCancels: async () => [],
        failAbandonedLaunches: async () => [],
      } as never,
      finisher as never,
      {} as never,
      sb as never,
      { get: () => ({ sandbox: { background: { pollSeconds: 5 } }, tools: {} }) } as never,
      {} as never,
      { info, warn, error: vi.fn(), debug: vi.fn() } as never,
      {} as never,
      redis as never,
    );
    await job.pollOnce();
    await job.pollOnce();
    expect(sb.held.exec).not.toHaveBeenCalled();
    expect(finisher.finish).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls.filter((c) => String(c[0]).includes("retirement gate"))).toHaveLength(1);
  });

  it("a legacy instance that is suspended or replaced finishes its task without any exec", async () => {
    const job = new BackgroundTaskPollJob(
      {
        runningLegacy: async () => [task],
        runningManaged: async () => [],
        owedCancels: async () => [],
        failAbandonedLaunches: async () => [],
      } as never,
      finisher as never,
      {} as never,
      sb as never,
      { get: () => ({ sandbox: { background: { pollSeconds: 5 } }, tools: {} }) } as never,
      {} as never,
      log,
      {} as never,
    );
    sb.ifRunning.mockResolvedValueOnce({ kind: "not_running", status: "suspended" });
    await job.pollOnce();
    sb.ifRunning.mockResolvedValueOnce({ kind: "other_instance" });
    await job.pollOnce();
    expect(sb.held.exec).not.toHaveBeenCalled();
    expect(finisher.finish.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { status: "lost", lostReason: "sandbox_suspended", killPending: true },
      { status: "lost", lostReason: "sandbox_recreated", killPending: false },
    ]);
  });
});
