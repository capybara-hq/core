import type { MediaBytes, MediaInfo } from "./context/build.js";

/**
 * 一次运行内的附件字节缓存（进程内，LRU，按总字节数封顶）：同一次运行的后续步骤不再重复取同一附件。
 * 上限取 `attachments.requestMediaBytes`：一次请求带的媒体字节不超过它，缓存再大也用不上。
 *
 * 多副本下允许：键含 finalize 时的 etag 与大小（内容不可变），只是优化——缓存未命中时照常从存储取，
 * 不同副本之间不共享、也不需要一致；随运行结束丢弃。
 */
export class MediaCache {
  private readonly entries = new Map<string, MediaBytes>();
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  /** 缓存键：附件 id、etag、声明大小与取的字节上限（`text/*` 只取开头）。 */
  static key(attachmentId: string, info: MediaInfo, cap: number | undefined): string {
    return [attachmentId, info.etag ?? "", info.size, cap ?? ""].join("\u0000");
  }

  /** 已缓存的总字节数。 */
  get size(): number {
    return this.total;
  }

  get(key: string): MediaBytes | undefined {
    const v = this.entries.get(key);
    if (v === undefined) return undefined;
    // 最近使用的移到末尾
    this.entries.delete(key);
    this.entries.set(key, v);
    return v;
  }

  /** 放入；比上限还大的不缓存。超出上限时淘汰最久未用的。 */
  set(key: string, value: MediaBytes): void {
    const n = value.data.byteLength;
    if (n > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) {
      this.total -= old.data.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.total += n;
    for (const [k, v] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.entries.delete(k);
      this.total -= v.data.byteLength;
    }
  }
}
