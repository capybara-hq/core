import type { ObjectHead, ObjectStore, PresignedUpload } from "@capybara-hq/plugin-sdk";

/** 测试用的内存 ObjectStore：按键排序列举，cursor 为上一页最后一个键。 */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();
  /** 每次调用的方法与（已加前缀的）键 / 前缀。 */
  readonly calls: { method: string; key: string }[] = [];

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts: { contentType: string },
  ): Promise<ObjectHead> {
    this.calls.push({ method: "put", key });
    const data =
      body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { data, contentType: opts.contentType });
    return { key, size: data.length, contentType: opts.contentType };
  }

  async get(key: string) {
    this.calls.push({ method: "get", key });
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      head: { key, size: o.data.length, contentType: o.contentType },
      body: new Response(o.data).body as ReadableStream<Uint8Array>,
    };
  }

  async head(key: string): Promise<ObjectHead | null> {
    this.calls.push({ method: "head", key });
    const o = this.objects.get(key);
    return o ? { key, size: o.data.length, contentType: o.contentType } : null;
  }

  async delete(key: string): Promise<void> {
    this.calls.push({ method: "delete", key });
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.calls.push({ method: "deletePrefix", key: prefix });
    let n = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) {
        this.objects.delete(k);
        n++;
      }
    }
    return n;
  }

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    this.calls.push({ method: "list", key: prefix });
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && (opts?.cursor === undefined || k > opts.cursor))
      .sort();
    const limit = opts?.limit ?? 1000;
    const page = keys.slice(0, limit);
    const items = page.map((k) => {
      const o = this.objects.get(k) as { data: Uint8Array };
      return { key: k, size: o.data.length, contentType: "" };
    });
    return keys.length > limit ? { items, cursor: page[page.length - 1] as string } : { items };
  }

  async presignGet(key: string): Promise<string> {
    this.calls.push({ method: "presignGet", key });
    return `https://store.test/${key}`;
  }

  async presignPut(key: string): Promise<PresignedUpload> {
    this.calls.push({ method: "presignPut", key });
    return { method: "POST", url: "https://store.test/", headers: {}, fields: { key } };
  }
}
