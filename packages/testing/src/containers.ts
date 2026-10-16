import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";

/** 测试容器句柄：连接串与停止函数。 */
export interface TestContainer {
  url: string;
  stop(): Promise<void>;
}

/** 启动一个临时 PostgreSQL 17 容器，返回连接串与停止函数。 */
export async function startTestPostgres(): Promise<TestContainer> {
  const container = await new PostgreSqlContainer("postgres:17").start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** 启动一个临时 Valkey 8（Redis 兼容）容器，返回 `redis://host:port` 与停止函数。 */
export async function startTestRedis(): Promise<TestContainer> {
  const container = await new GenericContainer("valkey/valkey:8")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
