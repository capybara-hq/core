import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
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

/**
 * MinIO 镜像。官方 `minio/minio` 已不再在 Docker Hub 发布，默认用社区维护的分支构建（`pgsty/minio`，
 * 命令与 S3 行为同官方）；可用环境变量 `CAPYBARA_TEST_MINIO_IMAGE` 换成私有镜像源。
 */
export const TEST_MINIO_IMAGE =
  process.env.CAPYBARA_TEST_MINIO_IMAGE || "pgsty/minio:RELEASE.2026-08-04T00-00-00Z";

/** {@link startTestMinio} 的句柄：S3 端点、凭据与已建好的桶。 */
export interface TestMinio {
  /** `http://host:port`（S3 API；用路径风格访问）。 */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  /** 区域（MinIO 默认 `us-east-1`）。 */
  region: string;
  stop(): Promise<void>;
}

/** 启动一个临时 MinIO（`server /data`），经 S3 API 建好桶 `capybara`，返回端点、凭据与停止函数。 */
export async function startTestMinio(): Promise<TestMinio> {
  const accessKey = "capybara-test";
  const secretKey = "capybara-test-secret";
  const bucket = "capybara";
  const region = "us-east-1";
  const container = await new GenericContainer(TEST_MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey })
    .withCommand(["server", "/data"])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (e) {
    await container.stop();
    throw e;
  } finally {
    client.destroy();
  }
  return {
    endpoint,
    accessKey,
    secretKey,
    bucket,
    region,
    stop: async () => {
      await container.stop();
    },
  };
}
