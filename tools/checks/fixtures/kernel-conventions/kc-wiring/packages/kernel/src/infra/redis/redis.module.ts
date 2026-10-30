import { Module } from "@nestjs/common";
import { LockService } from "../lock/lock.service.js";

@Module({ providers: [{ provide: "REDIS", useFactory: () => new LockService() }] })
export class RedisModule {}
