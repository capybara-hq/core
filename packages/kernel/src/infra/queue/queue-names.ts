/**
 * The kernel's own BullMQ queues, spelled as literals so infra code (the outbox registry) names a
 * queue without importing feature modules. `KERNEL_QUEUE_NAMES` (admin/health.service.ts) lists
 * the same names from the feature constants; test/infra/queue-names.test.ts keeps the two equal.
 */
export type KernelQueueName =
  | "cap-kernel-runs"
  | "cap-kernel-subagent-runs"
  | "cap-kernel-channels"
  | "cap-kernel-maintenance"
  | "cap-kernel-plugin-scope"
  | "cap-kernel-titles"
  | "cap-kernel-usage-report"
  | "cap-kernel-evals";
