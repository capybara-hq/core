import type { DeviceOwnerCeiling } from "@capybara-hq/plugin-sdk";

/**
 * A stored owner report (`device_machines.owner_report`) for a seeded machine row: without one a
 * machine fails closed (the OS sandbox). The default is the owner allowing work outside the
 * sandbox on the open network with the OS user's reach, what an `auto` machine used to report.
 */
export function storedOwnerReport(over: Partial<Omit<DeviceOwnerCeiling, "version">> = {}): string {
  const outsideSandbox = over.outsideSandbox ?? true;
  const report: DeviceOwnerCeiling = {
    version: 3,
    // sequence 0: any report a test records later (sequence 1 and up) supersedes it
    sequence: 0,
    revision: "test-owner-0",
    outsideSandbox,
    network: outsideSandbox ? "open" : "allowlist",
    allowedDomains: [],
    restrictedProjectReach: "os-user",
    ...over,
  };
  return JSON.stringify({
    report,
    connectionId: null,
    observedAt: new Date().toISOString(),
    via: "hello",
  });
}
