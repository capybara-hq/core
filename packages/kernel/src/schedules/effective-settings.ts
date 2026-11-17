import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import {
  invalidStoredForbiddenTools,
  parseOrgSettings,
  readStoredOrgSettings,
  type ScheduledTasksSettings,
} from "../orgs/settings.service.js";

/** The platform's bounds for the org settings (kernel config `schedules.*`). */
export interface ScheduleBounds {
  minIntervalFloorMinutes: number;
  maxTasksPerMemberCap: number;
  maxTasksPerOrgCap: number;
  maxRunsPerHourCap: number;
}

/**
 * The org's scheduled-task settings after clamping to the platform bounds. `forbiddenToolsUnreadable`:
 * the stored list cannot be read (`invalidStoredForbiddenTools`); `forbiddenTools` is then `[]`
 * and unattended runs of the org must fail instead of running with nothing forbidden.
 */
export type EffectiveScheduleSettings = ScheduledTasksSettings & {
  forbiddenToolsUnreadable: boolean;
};

/** An org value outside the platform bounds is clamped: the interval up, the counts down. */
export function effectiveScheduleSettings(
  org: ScheduledTasksSettings,
  bounds: ScheduleBounds,
  forbiddenToolsUnreadable = false,
): EffectiveScheduleSettings {
  return {
    ...org,
    forbiddenTools: [...org.forbiddenTools],
    forbiddenToolsUnreadable,
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
  const raw = await readStoredOrgSettings(db, orgId);
  return effectiveScheduleSettings(
    parseOrgSettings(raw).scheduledTasks,
    config.get().schedules,
    invalidStoredForbiddenTools(raw),
  );
}
