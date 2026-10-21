import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import type { Maintenance, MaintenanceHandler } from "../../src/runtime/maintenance.js";
import {
  registerSandboxMaintenance,
  SANDBOX_DESTROY_FOR_JOB,
  scheduleSandboxDestroy,
} from "../../src/sandbox/lifecycle.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";

/** 成员离职后的一次性销毁任务（fix wave S2 minor 5）：投递与 worker 上的处理。 */

function stubMaintenance() {
  const handlers = new Map<string, MaintenanceHandler>();
  const added: { name: string; data: unknown; opts: unknown }[] = [];
  const m = {
    handle: (name: string, fn: MaintenanceHandler) => void handlers.set(name, fn),
    schedule: () => undefined,
    add: async (name: string, data: unknown, opts: unknown) =>
      void added.push({ name, data, opts }),
  };
  return { m: m as unknown as Maintenance, handlers, added };
}

const job = (data: unknown) => ({ data }) as Job;

describe("sandbox-destroy-for", () => {
  it("投递：任务名、对话 id、失败重试", async () => {
    const { m, added } = stubMaintenance();
    await scheduleSandboxDestroy(m, ["c1", "c2"]);
    expect(added).toEqual([
      {
        name: SANDBOX_DESTROY_FOR_JOB,
        data: { conversationIds: ["c1", "c2"] },
        opts: expect.objectContaining({ attempts: expect.any(Number) }),
      },
    ]);
    expect(SANDBOX_DESTROY_FOR_JOB).not.toContain(":");
  });

  it("worker：逐个 destroyFor；有失败的记 warn 并让任务失败（整批重试），其余照常销毁", async () => {
    const { m, handlers } = stubMaintenance();
    const called: string[] = [];
    const warns: string[] = [];
    const sandbox = {
      destroyFor: async (id: string) => {
        called.push(id);
        if (id === "bad") throw new Error("provider down");
      },
    } as unknown as SandboxService;
    registerSandboxMaintenance(m, sandbox, {
      info: () => undefined,
      warn: (msg: string) => void warns.push(msg),
    });
    const run = handlers.get(SANDBOX_DESTROY_FOR_JOB) as MaintenanceHandler;
    await run(job({ conversationIds: ["a", "b"] }), undefined);
    expect(called).toEqual(["a", "b"]);
    await expect(run(job({ conversationIds: ["c", "bad", "d"] }), undefined)).rejects.toThrow(
      /1 of 3/,
    );
    expect(called).toEqual(["a", "b", "c", "bad", "d"]);
    expect(warns).toEqual(["cannot destroy sandbox of an offboarded member; will retry"]);
  });
});
