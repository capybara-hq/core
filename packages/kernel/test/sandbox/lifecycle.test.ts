import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  resetFilesJobId,
  runSandboxDestroyFor,
  runSandboxResetFiles,
  SANDBOX_DESTROY_FOR_JOB,
  SANDBOX_RESET_FILES_JOB,
  SandboxJobs,
} from "../../src/sandbox/jobs.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";

/**
 * The one-off sandbox maintenance jobs: the destruction of environments (deleted environments,
 * offboarding) and the reset of an environment's files; enqueue and worker side.
 */

/** A stand-in for the maintenance queue's producer side (`SandboxJobs`). */
function stubQueue() {
  const added: { name: string; data: unknown; opts: unknown }[] = [];
  const queue = {
    add: async (name: string, data: unknown, opts: unknown) =>
      void added.push({ name, data, opts }),
  };
  return { jobs: new SandboxJobs(queue as never), added };
}

const job = (data: unknown) => ({ data }) as Job;

describe("sandbox-destroy-for", () => {
  it("enqueue: job name, environment ids, retries on failure", async () => {
    const { jobs, added } = stubQueue();
    await jobs.destroy(["c1", "c2"]);
    expect(added).toEqual([
      {
        name: SANDBOX_DESTROY_FOR_JOB,
        data: { environmentIds: ["c1", "c2"] },
        opts: expect.objectContaining({ attempts: expect.any(Number) }),
      },
    ]);
    expect(SANDBOX_DESTROY_FOR_JOB).not.toContain(":");
  });

  it("worker: destroyEnvironment one by one; a failure is warned and fails the job (the batch is retried) after the others were destroyed", async () => {
    const called: string[] = [];
    const warns: string[] = [];
    const sandbox = {
      destroyEnvironment: async (id: string) => {
        called.push(id);
        if (id === "bad") throw new Error("provider down");
      },
    } as unknown as SandboxService;
    const log = { warn: (msg: string) => void warns.push(msg) };
    const run = (j: Job) => runSandboxDestroyFor(sandbox, log, j);
    await run(job({ environmentIds: ["a", "b"] }));
    expect(called).toEqual(["a", "b"]);
    await expect(run(job({ environmentIds: ["c", "bad", "d"] }))).rejects.toThrow(/1 of 3/);
    expect(called).toEqual(["a", "b", "c", "bad", "d"]);
    expect(warns).toEqual(["cannot destroy environment; will retry"]);
  });
});

describe("sandbox-reset-files", () => {
  it("enqueue: one deterministic job id per environment, retried, removed when it ends", async () => {
    const { jobs, added } = stubQueue();
    await jobs.resetFiles("env-1");
    expect(added).toEqual([
      {
        name: SANDBOX_RESET_FILES_JOB,
        data: { environmentId: "env-1" },
        opts: expect.objectContaining({
          jobId: "sandbox-reset-files-env-1",
          attempts: expect.any(Number),
          removeOnComplete: true,
          removeOnFail: true,
        }),
      },
    ]);
    expect(resetFilesJobId("env-1")).not.toContain(":");
  });

  it("worker: resets the environment's file system; a failure fails the job", async () => {
    const called: string[] = [];
    const sandbox = {
      resetFileSystem: async (id: string) => {
        called.push(id);
        if (id === "bad") throw new Error("lease not obtained");
      },
    } as unknown as SandboxService;
    await runSandboxResetFiles(sandbox, job({ environmentId: "env-1" }));
    expect(called).toEqual(["env-1"]);
    await expect(runSandboxResetFiles(sandbox, job({ environmentId: "bad" }))).rejects.toThrow(
      /lease/,
    );
  });
});
