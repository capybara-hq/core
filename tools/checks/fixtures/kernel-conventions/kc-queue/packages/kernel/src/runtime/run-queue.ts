import { Queue, QueueEvents, Worker as BullWorker } from "bullmq";
import { Worker } from "node:worker_threads";

export function start(): void {
  const q = new Queue("cap-kernel-runs"); // expect: kc-queue
  new BullWorker("cap-kernel-runs", async () => {}); // expect: kc-queue
  new QueueEvents("cap-kernel-runs"); // expect: kc-queue
  void q.upsertJobScheduler("sweep", { every: 1000 }); // expect: kc-queue
  new Worker("./thread.js");
}
