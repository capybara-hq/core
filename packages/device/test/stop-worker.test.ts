import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { stopWorker } from "../src/exec/operation-worker.js";

/** A child with an IPC channel running `script` (the private supervisor's place). */
function child(script: string) {
  const worker = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise<typeof worker>((resolve) => {
    worker.once("message", () => resolve(worker));
  });
}

describe("stopWorker", () => {
  it("waits for a supervisor that ends on its stop and kills nothing", async () => {
    const worker = await child(
      "process.on('message', m => { if (m.type === 'stop') process.disconnect(); });" +
        "setInterval(() => {}, 1000).unref(); process.send({ ready: true });",
    );
    const diagnostic = vi.fn();
    await stopWorker(worker, diagnostic, 30_000);
    expect(worker.exitCode).toBe(0);
    expect(worker.signalCode).toBeNull();
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("kills a supervisor whose teardown never ends, so the operation can end", async () => {
    // the sandbox runtime's proxy close waiting for a half-closed tunnel: the stop never completes
    const worker = await child(
      "process.on('message', () => {}); setInterval(() => {}, 1000); process.send({ ready: true });",
    );
    const diagnostic = vi.fn();
    await stopWorker(worker, diagnostic, 200);
    expect(worker.signalCode).toBe("SIGKILL");
    expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/did not end .*; killed/));
  });

  it("returns at once for a supervisor that already exited", async () => {
    const worker = await child("process.send({ ready: true }, () => process.exit(0));");
    await new Promise<void>((r) => {
      if (worker.exitCode !== null) r();
      else worker.once("exit", () => r());
    });
    await stopWorker(worker, undefined, 30_000);
    expect(worker.exitCode).toBe(0);
  });
});
