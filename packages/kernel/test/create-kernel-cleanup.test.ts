import { describe, expect, it, vi } from "vitest";

const destroyed = vi.hoisted(() => ({ db: 0, redisDisconnect: 0, busClose: 0 }));

// createHttpApp 构建失败：createKernel 应先释放已创建的 PG 池等连接对象再抛出
vi.mock("../src/http/app.js", () => ({
  createHttpApp: async () => {
    throw new Error("http init failed");
  },
}));
vi.mock("../src/db/pool.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db/pool.js")>();
  return {
    ...real,
    createDb: (...args: Parameters<typeof real.createDb>) => {
      const db = real.createDb(...args);
      const destroy = db.destroy.bind(db);
      db.destroy = async () => {
        destroyed.db++;
        await destroy();
      };
      return db;
    },
  };
});

vi.mock("ioredis", async (importOriginal) => {
  const real = await importOriginal<typeof import("ioredis")>();
  class CountingRedis extends real.Redis {
    override disconnect(reconnect?: boolean): void {
      destroyed.redisDisconnect++;
      super.disconnect(reconnect);
    }
  }
  return { ...real, Redis: CountingRedis, default: CountingRedis };
});
vi.mock("../src/ctx/bus.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ctx/bus.js")>();
  return {
    ...real,
    createBusSubscriber: (...args: Parameters<typeof real.createBusSubscriber>) => {
      const sub = real.createBusSubscriber(...args);
      const close = sub.close.bind(sub);
      sub.close = async () => {
        destroyed.busClose++;
        await close();
      };
      return sub;
    },
  };
});

const { KernelConfigSchema } = await import("../src/config/schema.js");
const { createKernel } = await import("../src/kernel.js");
const { createLogger } = await import("../src/log.js");

describe("createKernel 构建失败", () => {
  it("createHttpApp 抛错时断开 Redis、关闭总线订阅、销毁 PG 池后再抛出", async () => {
    const config = KernelConfigSchema.parse({
      // 不会真正连接：池与 Redis 都是惰性的
      db: { url: "postgres://u:p@127.0.0.1:1/db" },
      redis: { url: "redis://127.0.0.1:1" },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
    });
    await expect(
      createKernel(config, { env: {}, logger: createLogger("error", { write: () => {} }) }),
    ).rejects.toThrow("http init failed");
    expect(destroyed.db).toBe(1);
    expect(destroyed.redisDisconnect).toBeGreaterThanOrEqual(1);
    expect(destroyed.busClose).toBe(1);
  });
});
