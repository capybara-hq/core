export async function hit(redis: Redis, key: string): Promise<number> {
  return redis.incrby(key, 1);
}
