import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import {
  type AutomationsSettings,
  invalidStoredForbiddenTools,
  parseOrgSettings,
  readStoredOrgSettings,
} from "../orgs/settings.service.js";

/** The platform's bounds for the org settings (kernel config `automations.*`). */
export interface AutomationBounds {
  minIntervalFloorMinutes: number;
  maxTasksPerMemberCap: number;
  maxTasksPerOrgCap: number;
  maxRunsPerHourCap: number;
  maxEventDepthCap: number;
  coalesceSecondsCap: number;
  maxEventRunsPerSubjectPerHourCap: number;
}

/**
 * The org's automation settings after clamping to the platform bounds. `forbiddenToolsUnreadable`:
 * the stored list cannot be read (`invalidStoredForbiddenTools`); `forbiddenTools` is then `[]`
 * and unattended runs of the org must fail instead of running with nothing forbidden.
 */
export type EffectiveAutomationSettings = AutomationsSettings & {
  forbiddenToolsUnreadable: boolean;
};

/**
 * An org value outside the platform bounds is clamped: the interval up, the counts, the event
 * chain depth and the coalescing window down.
 */
export function effectiveAutomationSettings(
  org: AutomationsSettings,
  bounds: AutomationBounds,
  forbiddenToolsUnreadable = false,
): EffectiveAutomationSettings {
  return {
    ...org,
    forbiddenTools: [...org.forbiddenTools],
    eventSourcesOff: [...org.eventSourcesOff],
    forbiddenToolsUnreadable,
    minIntervalMinutes: Math.max(org.minIntervalMinutes, bounds.minIntervalFloorMinutes),
    maxTasksPerMember: Math.min(org.maxTasksPerMember, bounds.maxTasksPerMemberCap),
    maxTasksPerOrg: Math.min(org.maxTasksPerOrg, bounds.maxTasksPerOrgCap),
    maxRunsPerHour: Math.min(org.maxRunsPerHour, bounds.maxRunsPerHourCap),
    maxEventDepth: Math.min(org.maxEventDepth, bounds.maxEventDepthCap),
    coalesceSeconds: Math.min(org.coalesceSeconds, bounds.coalesceSecondsCap),
    maxEventRunsPerSubjectPerHour: Math.min(
      org.maxEventRunsPerSubjectPerHour,
      bounds.maxEventRunsPerSubjectPerHourCap,
    ),
  };
}

/** Read the org's effective settings live (PG and the current kernel config). */
export async function readAutomationSettings(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get">,
  orgId: string,
): Promise<EffectiveAutomationSettings> {
  const raw = await readStoredOrgSettings(db, orgId);
  return effectiveAutomationSettings(
    parseOrgSettings(raw).automations,
    config.get().automations,
    invalidStoredForbiddenTools(raw),
  );
}
