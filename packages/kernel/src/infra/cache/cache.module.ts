import { Global, Module } from "@nestjs/common";
import { CacheService } from "./cache.service.js";

/** Global: `CacheService` (and the `@Cacheable` / `@CacheEvict` decorators, which read it from `this.cacheService`). */
@Global()
@Module({ providers: [CacheService], exports: [CacheService] })
export class CacheModule {}
