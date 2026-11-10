import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { readOrgSettings, type ScheduledTasksSettings } from "../orgs/settings.service.js";

/** The platform's bounds for the org settings (kernel config `schedules.*`). */
export interface ScheduleBounds {
  minIntervalFloorMinutes: number;
  maxTasksPerMemberCap: number;
  maxTasksPerOrgCap: number;
  maxRunsPerHourCap: number;
}

/** The org's scheduled-task settings after clamping to the platform bounds. */
export type EffectiveScheduleSettings = ScheduledTasksSettings;

/** An org value outside the platform bounds is clamped: the interval up, the counts down. */
export function effectiveScheduleSettings(
  org: ScheduledTasksSettings,
  bounds: ScheduleBounds,
): EffectiveScheduleSettings {
  return {
    ...org,
    forbiddenTools: [...org.forbiddenTools],
    minIntervalMinutes: Math.max(org.minIntervalMinutes, bounds.minIntervalFloorMinutes),
    maxTasksPerMember: Math.min(org.maxTasksPerMember, bounds.maxTasksPerMemberCap),
    maxTasksPerOrg: Math.min(org.maxTasksPerOrg, bounds.maxTasksPerOrgCap),
    maxRunsPerHour: Math.min(org.maxRunsPerHour, bounds.maxRunsPerHourCap),
  };
}

/** Read the org's effective settings live (PG and the current kernel config). */
export async function readScheduleSettings(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get">,
  orgId: string,
): Promise<EffectiveScheduleSettings> {
  const org = await readOrgSettings(db, orgId);
  return effectiveScheduleSettings(org.scheduledTasks, config.get().schedules);
}
