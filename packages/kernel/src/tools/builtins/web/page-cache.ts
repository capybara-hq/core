import { createHash } from "node:crypto";
import type { WebFetchPage } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { CacheService } from "../../../infra/cache/cache.service.js";
import { KernelConfigService } from "../../../infra/config/kernel-config.service.js";

/**
 * The cache key of a fetched page: per org, provider and URL (the URL hashed, it may be long).
 * `CacheService` stores it under `cache:<key>`.
 */
export const webPageKey = (orgId: string, provider: string, url: string): string =>
  `web_page:${orgId}:${provider}:${createHash("sha256").update(url).digest("hex")}`;

/** A stored value read back as a page, or null when it is not one. */
function asPage(raw: string): WebFetchPage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.finalUrl !== "string" || typeof p.markdown !== "string") return null;
  return {
    finalUrl: p.finalUrl,
    markdown: p.markdown,
    ...(typeof p.title === "string" && { title: p.title }),
    ...(typeof p.contentType === "string" && { contentType: p.contentType }),
  };
}

/**
 * The `WebFetch` page cache (web tools spec §10): the provider's page (never the extraction,
 * which depends on the prompt) in Redis under {@link webPageKey}, for `web.fetch.cacheSeconds`
 * (read at every call; 0 turns the cache off). It saves the org's provider quota when an agent
 * reads the same page twice. Through `CacheService`, so it fails open: a Redis error is logged and
 * behaves like a miss or a skipped write. (Not named `*Cache`: that name is `infra/cache`'s.)
 */
@Injectable()
export class WebPages {
  constructor(
    @Inject(CacheService) private readonly cache: CacheService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
  ) {}

  private ttl(): number {
    return this.config.get().web.fetch.cacheSeconds;
  }

  /** The cached page of `url`, or null on a miss, when the cache is off or on a Redis error. */
  async get(orgId: string, provider: string, url: string): Promise<WebFetchPage | null> {
    if (this.ttl() <= 0) return null;
    const raw = await this.cache.get(webPageKey(orgId, provider, url));
    return raw === undefined ? null : asPage(raw);
  }

  /** Caches `page` for `url`; nothing when the cache is off. */
  async set(orgId: string, provider: string, url: string, page: WebFetchPage): Promise<void> {
    const ttl = this.ttl();
    if (ttl <= 0) return;
    await this.cache.setJson(webPageKey(orgId, provider, url), page, ttl);
  }
}
