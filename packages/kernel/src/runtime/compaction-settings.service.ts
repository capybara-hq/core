import { Inject, Injectable } from "@nestjs/common";
import {
  type CompactionSettings,
  effectiveCompactionSettings,
  SettingsService,
} from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { readOrgSettings } from "../orgs/settings.service.js";

export {
  COMPACTION_SETTINGS,
  type CompactionSettings,
  effectiveCompactionSettings,
} from "../identity/settings.js";

/**
 * The compaction settings in effect for one organization (context compaction spec §4.8):
 * the organization's override over the platform's stored settings, which carry the built-in
 * defaults. Read live on every model step, so a change in the admin console or the org settings
 * applies on the next step on every replica.
 */
@Injectable()
export class CompactionSettingsService {
  constructor(
    @Inject(SettingsService) private readonly settings: Pick<SettingsService, "get">,
    @Inject(KernelDb) private readonly db: KernelDb,
  ) {}

  /** The effective settings for `orgId`: org override > platform setting > built-in default. */
  async resolve(orgId: string): Promise<CompactionSettings> {
    const [platform, org] = await Promise.all([
      this.settings.get(),
      readOrgSettings(this.db.db, orgId),
    ]);
    return effectiveCompactionSettings(platform.compaction, org.compaction);
  }
}
