// The device policy op jobs' names and ids: a leaf module (no service imports), read by the
// producers (DevicePolicyService, MachinesService) and the maintenance processor.

/**
 * Settles a device policy op whose outcome was not recorded (transactional outbox spec §7): owed
 * by the op's intent transaction for when the op can no longer reach the machine, and by a hello
 * that reported its outcome. Consumed by `DeviceOpResolver` on the maintenance queue.
 */
export const DEVICE_OP_RESOLVE_JOB = "device-op-resolve";

/** The `device-op-resolve` job's data. */
export interface DeviceOpResolveData {
  machineId: string;
  opId: string;
}

/** The job id of the resolve job owed with an op's intent. */
export const deviceOpResolveJobId = (opId: string): string => `device-op-resolve-${opId}`;

/** The job id of the resolve job owed by a hello that reported the op's outcome. */
export const deviceOpReportedJobId = (opId: string): string => `device-op-reported-${opId}`;
