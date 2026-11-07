import { Injectable } from "@nestjs/common";

/**
 * The effective extension config of an org (spec A §5.3, §5.4, §6): the platform's, or the org's
 * copy of the overridable fields. For now only the count the admin console shows for an extension
 * whose platform config leaves required overridable fields empty (§5.4a); org copies are not
 * stored yet, so it is 0.
 */
@Injectable()
export class EffectiveConfigs {
  /** The number of orgs where the extension is on and has no valid effective config. */
  async countNeedingConfig(_plugin: string): Promise<number> {
    return 0;
  }
}
