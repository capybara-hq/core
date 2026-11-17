import { Module } from "@nestjs/common";
import { LegacyRetirementStore } from "./legacy-retirement.js";
import { PermissionCeilingWritesModule } from "./permission-authority.module.js";

/**
 * The legacy-launch freeze and the retirement obligations (permission runtime cutover 8.5), with
 * only the authority lock they publish and check under: the sandbox service gates every
 * lifecycle acquisition on it, the legacy launch checks the freeze, the local binder refuses to
 * bind over an obligation and the worker's retirement job drives it.
 */
@Module({
  imports: [PermissionCeilingWritesModule],
  providers: [LegacyRetirementStore],
  exports: [LegacyRetirementStore],
})
export class LegacyRetirementModule {}
