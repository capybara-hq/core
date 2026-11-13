import { describe, expect, it } from "vitest";
import { KERNEL_QUEUE_NAMES } from "../../src/admin/health.service.js";
import type { KernelQueueName } from "../../src/infra/queue/queue-names.js";

/**
 * `KernelQueueName` (infra) spells the kernel queue names as literals so infra imports no feature
 * constant; it must stay equal to `KERNEL_QUEUE_NAMES` (the feature constants the overview reads).
 */

// both directions at the type level: every listed name is a KernelQueueName, and no other
const listed = KERNEL_QUEUE_NAMES satisfies readonly KernelQueueName[];
type Unlisted = Exclude<KernelQueueName, (typeof KERNEL_QUEUE_NAMES)[number]>;
const noUnlisted: [Unlisted] extends [never] ? true : Unlisted = true;

const ALL: Record<KernelQueueName, true> = {
  "cap-kernel-runs": true,
  "cap-kernel-subagent-runs": true,
  "cap-kernel-channels": true,
  "cap-kernel-maintenance": true,
  "cap-kernel-plugin-scope": true,
  "cap-kernel-titles": true,
  "cap-kernel-usage-report": true,
  "cap-kernel-evals": true,
  "cap-kernel-lifecycle": true,
};

describe("KernelQueueName", () => {
  it("is the set of KERNEL_QUEUE_NAMES", () => {
    expect(noUnlisted).toBe(true);
    expect(new Set(Object.keys(ALL))).toEqual(new Set(listed));
  });
});
