import { Module } from "@nestjs/common";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { EnvironmentAccess } from "./access.js";
import { EnvironmentsService } from "./environments.service.js";

/**
 * Environments (spec 2026-11-07-environments-design): a person's environments
 * ({@link EnvironmentsService}) and who may use one ({@link EnvironmentAccess}). The instances and
 * file systems are the {@link SandboxModule}'s.
 */
@Module({
  imports: [SandboxModule],
  providers: [EnvironmentAccess, EnvironmentsService],
  exports: [EnvironmentAccess, EnvironmentsService],
})
export class EnvironmentsModule {}
