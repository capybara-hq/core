import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module.js";
import { ClientBuilds } from "./client-builds.service.js";

/**
 * Client extensions (spec 2026-11-09-client-extensions-design.md): the client builds stored with
 * extension packages ({@link ClientBuilds}).
 */
@Module({
  imports: [StorageModule],
  providers: [ClientBuilds],
  exports: [ClientBuilds],
})
export class ClientModule {}
