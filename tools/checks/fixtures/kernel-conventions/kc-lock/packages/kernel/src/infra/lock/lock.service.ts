import type { Redis } from "ioredis";

export async function acquire(redis: Redis): Promise<void> {
  await redis.set("lock:k", "t", "PX", 1000, "NX");
  const timer = setInterval(() => void redis.pexpire("lock:k", 1000), 300);
  clearInterval(timer);
}
