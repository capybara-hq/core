import { existsSync, readFileSync } from "node:fs";
import {
  type DeviceErrorKind,
  type DevicePolicyOpOutcome,
  type DevicePolicyOpReport,
  isPolicyOpId,
} from "@capybara-hq/plugin-sdk";
import { policyOpsPath, withPolicyLock, writePrivate } from "./state.js";

/** The most `policy` op outcomes the log keeps; the oldest is dropped first. */
export const MAX_LOGGED_POLICY_OPS = 100;

/**
 * One logged `policy` op: its id from the deployment, the outcome, and a refusal's message and
 * error kind (a repeated op is answered with them).
 */
export interface PolicyOpRecord {
  opId: string;
  outcome: DevicePolicyOpOutcome;
  message?: string;
  kind?: DeviceErrorKind;
  time: string;
}

const KINDS: readonly DeviceErrorKind[] = ["gone", "fs_gone", "policy", "error"];

const OUTCOMES: readonly DevicePolicyOpOutcome[] = ["applied", "refused", "started"];

function isRecord(v: unknown): v is PolicyOpRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    isPolicyOpId(o.opId) &&
    OUTCOMES.includes(o.outcome as DevicePolicyOpOutcome) &&
    (o.message === undefined || typeof o.message === "string") &&
    (o.kind === undefined || KINDS.includes(o.kind as DeviceErrorKind)) &&
    typeof o.time === "string"
  );
}

/**
 * The outcomes of the latest `policy` ops, by the deployment's op id, in
 * `<stateDir>/policy-ops.json` (oldest first, at most {@link MAX_LOGGED_POLICY_OPS}). An op is
 * logged `started` before the policy is written, then `applied` or `refused`; one the program was
 * stopped in the middle of stays `started`. The deployment reads it with `policyStatus` and in
 * each hello (`recentOps`). Writes hold policy.json.lock, so they never interleave with a policy
 * change.
 */
export class PolicyOpLog {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = policyOpsPath(dir);
  }

  /** The logged ops, oldest first; a missing or unreadable file (or entry) reads as none. */
  entries(): PolicyOpRecord[] {
    if (!existsSync(this.file)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // a broken log is replaced at the next write: the deployment then learns less, never more
      return [];
    }
    return Array.isArray(raw) ? raw.filter(isRecord).slice(-MAX_LOGGED_POLICY_OPS) : [];
  }

  get(opId: string): PolicyOpRecord | undefined {
    return this.entries().find((e) => e.opId === opId);
  }

  /** The outcomes a hello reports, oldest first. */
  recent(): DevicePolicyOpReport[] {
    return this.entries().map((e) => ({ opId: e.opId, outcome: e.outcome }));
  }

  /** Logs an outcome under the policy lock. */
  record(entry: Omit<PolicyOpRecord, "time">): void {
    withPolicyLock(this.dir, () => this.recordHeld(entry));
  }

  /**
   * Logs an outcome; the caller holds policy.json.lock. A later outcome of the same op replaces
   * its entry and moves it last.
   */
  recordHeld(entry: Omit<PolicyOpRecord, "time">): void {
    const next: PolicyOpRecord = { ...entry, time: new Date().toISOString() };
    const kept = this.entries().filter((e) => e.opId !== entry.opId);
    kept.push(next);
    writePrivate(this.file, `${JSON.stringify(kept.slice(-MAX_LOGGED_POLICY_OPS), null, 2)}\n`);
  }

  /**
   * Under the policy lock: the op's final outcome when it was applied or refused before (the
   * caller answers from it), else logs it `started` and returns undefined (an op left `started`
   * by an interrupted run is taken again: its content is idempotent).
   */
  claim(opId: string): PolicyOpRecord | undefined {
    return withPolicyLock(this.dir, () => {
      const known = this.get(opId);
      if (known !== undefined && known.outcome !== "started") return known;
      this.recordHeld({ opId, outcome: "started" });
      return undefined;
    });
  }
}
