import { Queue } from "bullmq";

export async function dispatch(queue: Queue): Promise<void> {
  await queue.addBulk([]);
}
