import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createKernel, type Kernel, KernelConfigSchema } from "@capybara-hq/kernel";
import pg from "pg";
import { startTestPostgres, startTestRedis, type TestContainer } from "./containers.js";

/** 双副本测试工具的选项。 */
export interface DualReplicaOptions {
  /** 要加载的插件（绝对路径、file URL 或可解析的包名）。 */
  plugins: string[];
  /** 部署级插件配置，按插件名索引。 */
  pluginConfig?: Record<string, unknown>;
  /**
   * 复用已有的 PostgreSQL（管理员连接串，需能 CREATE DATABASE）。
   * 省略则本工具自己起一个容器，并在 stop() 时关闭；传入则 stop() 不动它。
   */
  pgUrl?: string;
  /**
   * 复用已有的 Redis。省略则每个 harness 自己起一个容器（Redis 层完全隔离）；
   * 传入时 harness 不做隔离，调用方负责保证该实例不被其他并发 harness 共用。
   */
  redisUrl?: string;
}

/** 两个内核副本 + 严格交替的请求入口。 */
export interface Harness {
  /** 严格交替发往两个副本：第 1、3、5… 次到 replica 0，第 2、4、6… 次到 replica 1。 */
  request(path: string, init?: RequestInit): Promise<Response>;
  replicas: [Kernel, Kernel];
  /** 先停两个内核，再停自己起的容器与临时库；幂等。 */
  stop(): Promise<void>;
}

/** 在管理库上新建一个随机名数据库，返回指向它的连接串。每个 harness 一个新库，状态互不串。 */
async function createFreshDatabase(adminUrl: string): Promise<string> {
  const name = `cap_${randomBytes(6).toString("hex")}`;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * 两个副本跑在同一个进程里，ES 模块缓存是共享的：同一个插件文件 import 两次会拿到同一份模块，
 * 模块级状态（Map、计数器）就被两个「副本」偷偷共用，进程内状态缺陷反而测不出来。
 * 给 file URL 加上副本专属的查询串，让每个副本各自求值一份插件入口模块，模拟「各自一个进程」。
 * 只对绝对路径 / file URL 生效；插件入口以外被 import 的模块仍是共享的（真进程隔离做不到时的近似）。
 */
function isolatePlugin(spec: string, replica: number): string {
  let href: string;
  if (spec.startsWith("file:")) href = spec;
  else if (isAbsolute(spec)) href = pathToFileURL(spec).href;
  else return spec;
  const url = new URL(href);
  url.searchParams.set("capybara-replica", String(replica));
  return url.href;
}

/**
 * 启动两个共享同一套 PG / Redis、同一 masterKey 的内核副本（角色含 api 与 worker，
 * HTTP 监听端口为 0 由系统分配，请求走 `app.request`，不经网络）。
 * 两个副本都启动完成后才 resolve；用来暴露「只在多副本下才出现」的进程内状态缺陷。
 */
export async function createDualReplicaHarness(opts: DualReplicaOptions): Promise<Harness> {
  const owned: TestContainer[] = [];
  const kernels: Kernel[] = [];
  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      await Promise.allSettled(kernels.map((k) => k.stop()));
      await Promise.allSettled(owned.map((c) => c.stop()));
    })();
    return stopPromise;
  };

  try {
    let pgUrl = opts.pgUrl;
    if (pgUrl === undefined) {
      const c = await startTestPostgres();
      owned.push(c);
      pgUrl = c.url;
    }
    let redisUrl = opts.redisUrl;
    if (redisUrl === undefined) {
      const c = await startTestRedis();
      owned.push(c);
      redisUrl = c.url;
    }
    const dbUrl = await createFreshDatabase(pgUrl);
    const masterKey = randomBytes(32).toString("base64");
    const config = (replica: number) =>
      KernelConfigSchema.parse({
        db: { url: dbUrl, poolMax: 3 },
        redis: { url: redisUrl },
        masterKey,
        http: { port: 0 },
        roles: ["api", "worker", "gateway"],
        plugins: opts.plugins.map((p) => isolatePlugin(p, replica)),
        pluginConfig: opts.pluginConfig ?? {},
        log: { level: "error" },
      });

    const k0 = await createKernel(config(0));
    const k1 = await createKernel(config(1));
    kernels.push(k0, k1);
    await Promise.all([k0.start(), k1.start()]);

    const replicas: [Kernel, Kernel] = [k0, k1];
    let calls = 0;
    return {
      replicas,
      stop,
      async request(path, init) {
        const replica = replicas[calls++ % 2] as Kernel;
        return await replica.app.request(path, init);
      },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
