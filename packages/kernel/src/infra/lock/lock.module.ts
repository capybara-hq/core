import { Global, Module } from "@nestjs/common";
import { LockService } from "./lock.service.js";

/** Global: `LockService` (and the `@WithLock` decorator, which reads it from `this.lockService`). */
@Global()
@Module({ providers: [LockService], exports: [LockService] })
export class LockModule {}
