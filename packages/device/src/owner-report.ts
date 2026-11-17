import { closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type DeviceOwnerCeilingV3, parseOwnerCeilingReportV3 } from "@capybara-hq/plugin-sdk";
import { readStrictOwnerCeilingSync } from "./exec/operation-types.js";
import { withPolicyLock, writePrivate } from "./state.js";

/**
 * The private sidecar that keeps the owner report's sequence (permission runtime cutover B2):
 * `{sequence, lastPublishedRevision}` next to policy.json. It is not policy input, so issuing a
 * report never changes the policy revision it reports.
 */
export function ownerReportPath(stateDir: string): string {
  return join(stateDir, "owner-report.json");
}

interface OwnerReportState {
  sequence: number;
  lastPublishedRevision: string;
}

/** The sidecar, or undefined when absent. Throws on corrupt content (never restarts at zero). */
function readState(stateDir: string): OwnerReportState | undefined {
  const file = ownerReportPath(stateDir);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${(e as Error).message}); run capybara-device login again to reset it`,
    );
  }
  const o = raw as Record<string, unknown> | null;
  if (
    typeof o !== "object" ||
    o === null ||
    Array.isArray(o) ||
    Object.keys(o).length !== 2 ||
    typeof o.sequence !== "number" ||
    !Number.isSafeInteger(o.sequence) ||
    o.sequence < 0 ||
    typeof o.lastPublishedRevision !== "string" ||
    o.lastPublishedRevision.length === 0
  ) {
    throw new Error(
      `${file} is invalid; run capybara-device login again to reset the owner report sequence`,
    );
  }
  return { sequence: o.sequence, lastPublishedRevision: o.lastPublishedRevision };
}

/**
 * Resets the sequence for a new machine credential (`login`), under the policy lock and durably:
 * the deployment keeps reports per machine credential, so the new one starts a new sequence. This
 * is the repair of a lost or corrupt sidecar.
 */
export function resetOwnerReport(stateDir: string): void {
  withPolicyLock(stateDir, () => {
    rmSync(ownerReportPath(stateDir), { force: true });
    const fd = openSync(stateDir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}

/** Writes the sidecar durably (atomic rename, then the file and its directory synced). */
function writeState(stateDir: string, state: OwnerReportState): void {
  const file = ownerReportPath(stateDir);
  writePrivate(file, `${JSON.stringify(state)}\n`);
  for (const path of [file, stateDir]) {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * The strict owner report for the policy now (B2), used as the hello, `policy` frame, policy
 * answers and bind answer `ownerCeiling`. Under the policy lock: the strict reader validates the
 * version-2 policy; a newly observed revision advances the sequence, durably written before the
 * report is returned (a crash before that emits no report). A missing, old-format or invalid policy
 * and a corrupt sidecar throw: no report, no widening.
 */
export function issueOwnerReport(input: {
  stateDir: string;
  deviceId: string;
  dir: string;
  home?: string;
}): DeviceOwnerCeilingV3 {
  return withPolicyLock(input.stateDir, () => {
    const ceiling = readStrictOwnerCeilingSync(input);
    const state = readState(input.stateDir);
    let sequence = state?.sequence ?? 0;
    if (state === undefined || state.lastPublishedRevision !== ceiling.revision) {
      sequence = state === undefined ? 0 : state.sequence + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Owner report sequence exhausted");
      writeState(input.stateDir, { sequence, lastPublishedRevision: ceiling.revision });
    }
    return parseOwnerCeilingReportV3({
      version: 2,
      revision: ceiling.revision,
      sequence,
      fullAccess: ceiling.fullAccess,
      restrictedProjectReach: ceiling.restrictedProjectReach,
      restrictedAllowedDomains: [...ceiling.restrictedAllowedDomains],
    });
  });
}
