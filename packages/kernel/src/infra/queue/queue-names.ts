/**
 * The kernel's own BullMQ queues, spelled as literals so infra code (the outbox registry and
 * dispatcher) names a queue without importing feature modules. `KERNEL_QUEUE_NAMES`
 * (admin/health.service.ts) lists the same names from the feature constants;
 * test/infra/queue-names.test.ts keeps the two equal.
 */
export const KERNEL_QUEUES = [
  "cap-kernel-runs",
  "cap-kernel-subagent-runs",
  "cap-kernel-channels",
  "cap-kernel-maintenance",
  "cap-kernel-plugin-scope",
  "cap-kernel-titles",
  "cap-kernel-usage-report",
  "cap-kernel-evals",
  "cap-kernel-lifecycle",
] as const;

export type KernelQueueName = (typeof KERNEL_QUEUES)[number];
