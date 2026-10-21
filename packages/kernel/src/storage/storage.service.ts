import {
  CapabilityUnavailableError,
  type ObjectHead,
  type ObjectStore,
  type PluginStorage,
} from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
import { assertOrgId, KeySpace, kernelPrefix, pluginPrefix } from "./prefix.js";

export { StorageKeyError } from "./prefix.js";

/** 没有对象存储提供方时的错误（HTTP 层映射为 `storage.unavailable`，503）。 */
export const storageUnavailable = (): CapabilityUnavailableError =>
  new CapabilityUnavailableError(
    "storage.unavailable: object storage is not available in this deployment",
  );

export interface StorageServiceDeps {
  /** 当前的 `object-store@1` 提供方；每次调用时取（提供方在插件加载过程中才就绪）。 */
  provider: () => ObjectStore | undefined;
  /** 可能存过数据的插件名（删除组织数据时逐个删 `plugins/<插件>/<orgId>/`）。 */
  plugins: () => Promise<string[]>;
}

/**
 * 内核的对象存储服务（扩展模型 §5）：在 `object-store@1` 提供方之上加前缀隔离。
 * - 插件经 {@link forPlugin} 拿到 `ctx.storage`：键落在 `plugins/<插件>/<orgId>/` 下；
 * - 内核功能经 {@link kernel} 用 `kernel/<orgId>/`；
 * - 返回给调用方的键（`head` / `get` / `put` / `list`）都去掉前缀，列举结果只保留本前缀下的对象。
 * 没有提供方时各方法 reject `storage.unavailable`（{@link available} 为 false）。本身无状态，可多副本共用。
 */
export class StorageService {
  constructor(private readonly d: StorageServiceDeps) {}

  /** 是否有对象存储提供方。 */
  get available(): boolean {
    return this.d.provider() !== undefined;
  }

  /** 依赖存储的 HTTP 功能在入口调用：没有提供方时抛 `ApiError("storage.unavailable")`（503）。 */
  assertAvailable(): void {
    if (!this.available) {
      throw new ApiError(
        "storage.unavailable",
        "Object storage is not available in this deployment; install an object-store plugin",
      );
    }
  }

  /** 插件的 `ctx.storage`：每个方法先校验 orgId 与键，再加前缀 `plugins/<plugin>/<orgId>/`。 */
  forPlugin(plugin: string): PluginStorage {
    // 先按一个合法的组织 id 校验插件名：名字不合法时立即抛错，而不是等到第一次调用
    pluginPrefix(plugin, "00000000-0000-0000-0000-000000000000");
    const space = (orgId: string) => new KeySpace(pluginPrefix(plugin, orgId));
    const run = async <T>(orgId: string, fn: (s: ScopedStore) => Promise<T>): Promise<T> => {
      const store = this.require();
      return fn(new ScopedStore(store, space(orgId)));
    };
    return {
      put: (orgId, key, body, opts) => run(orgId, (s) => s.put(key, body, opts)),
      get: (orgId, key, opts) => run(orgId, (s) => s.get(key, opts)),
      head: (orgId, key) => run(orgId, (s) => s.head(key)),
      delete: (orgId, key) => run(orgId, (s) => s.delete(key)),
      deletePrefix: (orgId, prefix) => run(orgId, (s) => s.deletePrefix(prefix)),
      list: (orgId, prefix, opts) => run(orgId, (s) => s.list(prefix, opts)),
      presignGet: (orgId, key, opts) => run(orgId, (s) => s.presignGet(key, opts)),
      presignPut: (orgId, key, opts) => run(orgId, (s) => s.presignPut(key, opts)),
    };
  }

  /** 内核在该组织下的存储（前缀 `kernel/<orgId>/`）。orgId 不是 UUID 时立即抛 StorageKeyError。 */
  kernel(orgId: string): ObjectStore {
    const ks = new KeySpace(kernelPrefix(orgId));
    const scoped = () => new ScopedStore(this.require(), ks);
    return {
      put: async (key, body, opts) => scoped().put(key, body, opts),
      get: async (key, opts) => scoped().get(key, opts),
      head: async (key) => scoped().head(key),
      delete: async (key) => scoped().delete(key),
      deletePrefix: async (prefix) => scoped().deletePrefix(prefix),
      list: async (prefix, opts) => scoped().list(prefix, opts),
      presignGet: async (key, opts) => scoped().presignGet(key, opts),
      presignPut: async (key, opts) => scoped().presignPut(key, opts),
    };
  }

  /** 删除该组织的全部对象：`kernel/<orgId>/` 与每个插件的 `plugins/<插件>/<orgId>/`。返回删除数。 */
  async deleteOrg(orgId: string): Promise<number> {
    const store = this.require();
    assertOrgId(orgId);
    let n = await store.deletePrefix(kernelPrefix(orgId));
    for (const plugin of new Set(await this.d.plugins())) {
      n += await store.deletePrefix(pluginPrefix(plugin, orgId));
    }
    return n;
  }

  private require(): ObjectStore {
    const store = this.d.provider();
    if (!store) throw storageUnavailable();
    return store;
  }
}

/** 一个前缀下的 ObjectStore 视图：键先校验再拼接，返回的键去掉前缀。 */
class ScopedStore implements ObjectStore {
  constructor(
    private readonly store: ObjectStore,
    private readonly space: KeySpace,
  ) {}

  private rel(h: ObjectHead, key: string): ObjectHead {
    return { ...h, key };
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts: { contentType: string; size?: number; signal?: AbortSignal },
  ): Promise<ObjectHead> {
    return this.rel(await this.store.put(this.space.key(key), body, opts), key);
  }

  async get(key: string, opts?: { signal?: AbortSignal; range?: { start: number; end?: number } }) {
    const r = await this.store.get(this.space.key(key), opts);
    return r ? { head: this.rel(r.head, key), body: r.body } : null;
  }

  async head(key: string): Promise<ObjectHead | null> {
    const h = await this.store.head(this.space.key(key));
    return h ? this.rel(h, key) : null;
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(this.space.key(key));
  }

  async deletePrefix(prefix: string): Promise<number> {
    return this.store.deletePrefix(this.space.listPrefix(prefix));
  }

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    const r = await this.store.list(this.space.listPrefix(prefix), opts);
    // 防御：提供方返回了前缀之外的键时丢掉，调用方永远看不到别的前缀
    const items = r.items
      .filter((i) => this.space.owns(i.key))
      .map((i) => this.rel(i, this.space.strip(i.key)));
    return r.cursor === undefined ? { items } : { items, cursor: r.cursor };
  }

  async presignGet(key: string, opts: { ttlSeconds: number; downloadName?: string }) {
    return this.store.presignGet(this.space.key(key), opts);
  }

  async presignPut(
    key: string,
    opts: { contentType: string; maxSize: number; ttlSeconds: number },
  ) {
    return this.store.presignPut(this.space.key(key), opts);
  }
}
