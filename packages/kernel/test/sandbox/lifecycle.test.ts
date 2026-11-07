import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  runSandboxDestroyFor,
  SANDBOX_DESTROY_FOR_JOB,
  SandboxJobs,
} from "../../src/sandbox/jobs.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";

/** The one-off destruction of environments (deleted environments, offboarding): enqueue and worker side. */

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
