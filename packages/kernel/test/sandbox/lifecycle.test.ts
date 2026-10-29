import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  runSandboxDestroyFor,
  SANDBOX_DESTROY_FOR_JOB,
  SandboxJobs,
  sandboxDestroyJobId,
} from "../../src/sandbox/jobs.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";

/** 成员离职后的一次性销毁任务（fix wave S2 minor 5）：投递与 worker 上的处理。 */

/** A stand-in for the maintenance queue's producer side (Task 3.8: `SandboxJobs`). */
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
  it("投递：任务名、对话 id、失败重试", async () => {
    const { jobs, added } = stubQueue();
    await jobs.destroy(["c1", "c2"]);
    expect(added).toEqual([
      {
        name: SANDBOX_DESTROY_FOR_JOB,
        data: { conversationIds: ["c1", "c2"] },
        opts: expect.objectContaining({ attempts: expect.any(Number) }),
      },
    ]);
    expect(SANDBOX_DESTROY_FOR_JOB).not.toContain(":");
  });

  it("job id: deterministic per batch (any order), no `:`", async () => {
    const { jobs, added } = stubQueue();
    await jobs.destroy(["c2", "c1"]);
    await jobs.destroy(["c1", "c2"]);
    await jobs.destroy(["c3"]);
    const ids = added.map((a) => (a.opts as { jobId: string }).jobId);
    expect(ids[0]).toBe(sandboxDestroyJobId(["c1", "c2"]));
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    for (const id of ids) {
      expect(id).not.toContain(":");
      expect(id.startsWith(`${SANDBOX_DESTROY_FOR_JOB}-`)).toBe(true);
    }
  });

  it("worker：逐个 destroyFor；有失败的记 warn 并让任务失败（整批重试），其余照常销毁", async () => {
    const called: string[] = [];
    const warns: string[] = [];
    const sandbox = {
      destroyFor: async (id: string) => {
        called.push(id);
        if (id === "bad") throw new Error("provider down");
      },
    } as unknown as SandboxService;
    const log = { warn: (msg: string) => void warns.push(msg) };
    const run = (j: Job) => runSandboxDestroyFor(sandbox, log, j);
    await run(job({ conversationIds: ["a", "b"] }));
    expect(called).toEqual(["a", "b"]);
    await expect(run(job({ conversationIds: ["c", "bad", "d"] }))).rejects.toThrow(/1 of 3/);
    expect(called).toEqual(["a", "b", "c", "bad", "d"]);
    expect(warns).toEqual(["cannot destroy sandbox of an offboarded member; will retry"]);
  });
});
