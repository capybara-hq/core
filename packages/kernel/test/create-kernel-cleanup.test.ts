import { describe, expect, it, vi } from "vitest";

const destroyed = vi.hoisted(() => ({ db: 0 }));

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

const { KernelConfigSchema } = await import("../src/config/schema.js");
const { createKernel } = await import("../src/kernel.js");
const { createLogger } = await import("../src/log.js");

describe("createKernel 构建失败", () => {
  it("createHttpApp 抛错时销毁 PG 池后再抛出", async () => {
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
  });
});
