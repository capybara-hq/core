import { Module } from "@nestjs/common";
import { OperationAuthorityModule } from "./operation-authority.module.js";
import { SandboxOperationIntents } from "./operation-intents.js";
import { OperationPayloads } from "./operation-payloads.js";
import { PermissionAuthorityModule } from "./permission-authority.module.js";
@Module({
  imports: [OperationAuthorityModule, PermissionAuthorityModule],
  providers: [OperationPayloads, SandboxOperationIntents],
  exports: [SandboxOperationIntents],
})
export class OperationIntentsModule {}
