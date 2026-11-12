import { Queue } from "bullmq";

export async function addJobOnce(q: Queue): Promise<void> {
  await q.add("x", {});
}
