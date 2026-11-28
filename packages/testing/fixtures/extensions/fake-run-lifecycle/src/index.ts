import { defineExtension, type RunLifecyclePayload } from "@capybara-hq/plugin-sdk";

/**
 * Test fake of a plugin that shows run state on its subjects: it observes `run.lifecycle` and
 * records every payload, in order, on `globalThis.__fakeRunLifecycle.calls` (in-process kernels
 * only; {@link fakeRunLifecycleProbe}). `failTimes` on the probe makes the first N calls throw
 * (a handler failure never affects the run; the kernel retries the delivery).
 */

/** The probe tests read and script. */
export interface FakeRunLifecycleProbe {
  /** Every payload a handler call received, in order (a retried delivery appears again). */
  calls: RunLifecyclePayload[];
  /** The first this many calls throw after being recorded. */
  failTimes?: number;
}

export function fakeRunLifecycleProbe(): FakeRunLifecycleProbe {
  const g = globalThis as { __fakeRunLifecycle?: FakeRunLifecycleProbe };
  g.__fakeRunLifecycle ??= { calls: [] };
  return g.__fakeRunLifecycle;
}

export default defineExtension({
  name: "fake-run-lifecycle",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { hooks: ["run.lifecycle"] },
  setup(ctx) {
    ctx.hooks.on(
      "run.lifecycle",
      (p) => {
        const probe = fakeRunLifecycleProbe();
        probe.calls.push({ ...p });
        if (probe.failTimes !== undefined && probe.calls.length <= probe.failTimes)
          throw new Error("fake-run-lifecycle: scripted failure");
      },
      { mode: "observe" },
    );
  },
});
