import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module.js";
import { ClientAccess } from "./client-access.service.js";
import { ClientBuilds } from "./client-builds.service.js";
import { ClientReports } from "./client-reports.service.js";
import { ClientSignIn } from "./client-sign-in.service.js";

/**
 * Client extensions (spec 2026-11-09-client-extensions-design.md): the client builds stored with
 * extension packages ({@link ClientBuilds}) and who may load them ({@link ClientAccess}: the
 * delivery route and the shell reads, whose controllers the api role lists; {@link ClientSignIn}:
 * the per-plugin sign-in ids of those reads).
 */
@Module({
  imports: [StorageModule],
  providers: [ClientBuilds, ClientAccess, ClientReports, ClientSignIn],
  exports: [ClientBuilds, ClientAccess, ClientReports, ClientSignIn],
})
export class ClientModule {}
