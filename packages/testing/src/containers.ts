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
 * S3 兼容存储的测试镜像：官方 SeaweedFS（`chrislusf/seaweedfs`，Apache-2.0），按标签加摘要固定。
 * 它的 S3 网关会校验 POST 策略的 `content-length-range`、`eq $Content-Type` 与 `key` 条件。
 * 可用环境变量 `CAPYBARA_TEST_S3_IMAGE` 换成私有镜像源。
 */
export const TEST_S3_IMAGE =
  process.env.CAPYBARA_TEST_S3_IMAGE ||
  "chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d";

/** {@link startTestS3} 的句柄：S3 端点、凭据与已建好的桶。 */
export interface TestS3 {
  /** `http://host:port`（S3 API；用路径风格访问）。 */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  stop(): Promise<void>;
}

/** 建桶时等待 S3 网关连上 filer 的上限。 */
const S3_READY_TIMEOUT_MS = 60_000;

/**
 * 启动一个临时 SeaweedFS（`weed server -s3`，单容器含 master / volume / filer / S3 网关），
 * 启用带凭据的 S3 鉴权，经 S3 API 建好桶 `capybara`，返回端点、凭据与停止函数。
 */
export async function startTestS3(): Promise<TestS3> {
  const accessKey = "capybara-test";
  const secretKey = "capybara-test-secret";
  const bucket = "capybara";
  const region = "us-east-1";
  const s3Config = JSON.stringify({
    identities: [
      {
        name: "admin",
        credentials: [{ accessKey, secretKey }],
        actions: ["Admin", "Read", "List", "Tagging", "Write"],
      },
    ],
  });
  const container = await new GenericContainer(TEST_S3_IMAGE)
    .withCopyContentToContainer([{ content: s3Config, target: "/etc/seaweedfs/s3.json" }])
    .withCommand(["server", "-s3", "-s3.config=/etc/seaweedfs/s3.json", "-dir=/data"])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forLogMessage(/Starting S3 API Server/))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(8333)}`;
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  try {
    // 网关先于 filer 就绪：建桶失败时重试，直到超时
    const deadline = Date.now() + S3_READY_TIMEOUT_MS;
    for (;;) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
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
