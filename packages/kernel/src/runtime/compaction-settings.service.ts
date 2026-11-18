import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
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
 * The effective compaction settings for `orgId` (org override > platform setting > built-in
 * default), read live from the platform settings and the org row. Shared by
 * {@link CompactionSettingsService} and readers outside the runtime module (the prompt suggestion
 * job), which would otherwise import the runtime module in a cycle.
 */
export async function resolveCompactionSettings(
  settings: Pick<SettingsService, "get">,
  db: KernelSchemaDb,
  orgId: string,
): Promise<CompactionSettings> {
  const [platform, org] = await Promise.all([settings.get(), readOrgSettings(db, orgId)]);
  return effectiveCompactionSettings(platform.compaction, org.compaction);
}

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
  resolve(orgId: string): Promise<CompactionSettings> {
    return resolveCompactionSettings(this.settings, this.db.db, orgId);
  }
}
