import {
  parseSandboxExecutionRef,
  type SandboxBackground,
  type SandboxExecutionRef,
  type SandboxExecutionStatus,
  type SandboxHandle,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  type SandboxStopResult,
} from "@capybara-hq/plugin-sdk";
import type { IfRunningResult, SandboxService } from "../sandbox/sandbox.service.js";
import type { BackgroundFinish } from "./finish.js";
import { lastLinesOf, type OutputReader } from "./managed-output.js";
import type { BackgroundTaskRow } from "./store.js";

/*
 * The consumers' side of a managed background task (permission runtime cutover phase 8.3): every
 * status, read, tail and stop goes to the task's exact recorded execution ref on its exact
 * recorded instance generation, through `SandboxService.ifRunning` (never creating, resuming or
 * rebuilding an instance) and `SandboxBackground` (never an exec, a path or a new scope).
 */

/** The task's recorded ref or generation is malformed or inconsistent: it is never used. */
export class ManagedRefError extends Error {
  constructor(taskId: string) {
    super(
      `Background task ${taskId}'s recorded execution reference is malformed or inconsistent; it cannot be read or stopped`,
    );
    this.name = "ManagedRefError";
  }
}

/** The grace a stop gives the task's processes before they are killed. */
export const MANAGED_STOP_GRACE_MS = 5000;
/** The most bytes a summary's tail asks for (the summary keeps 20 lines, 4,000 characters). */
export const MANAGED_TAIL_BYTES = 12_000;

/** The task's exact ref and instance generation, validated against its own recorded identity. */
export function exactRefOf(task: BackgroundTaskRow): {
  ref: SandboxExecutionRef;
  deviceId: string;
  generation: number;
} {
  const bad = () => new ManagedRefError(task.id);
  if (
    task.executionRef === null ||
    task.operationId === null ||
    task.instanceId === null ||
    task.instanceGeneration === null ||
    task.deviceId === null ||
    !/^[0-9]{1,16}$/.test(task.instanceGeneration)
  )
    throw bad();
  let ref: SandboxExecutionRef;
  try {
    ref = parseSandboxExecutionRef(task.executionRef);
  } catch {
    throw bad();
  }
  const generation = Number(task.instanceGeneration);
  if (
    !Number.isSafeInteger(generation) ||
    ref.operationId !== task.operationId ||
    ref.instanceId !== task.instanceId ||
    ref.instanceGeneration !== task.instanceGeneration ||
    (task.sandboxCreatedAt !== null && task.sandboxCreatedAt.getTime() !== generation)
  )
    throw bad();
  return { ref, deviceId: task.deviceId, generation };
}

/**
 * Runs `fn` with the provider's background supervision on the task's exact recorded instance
 * only: `not_running` / `other_instance` otherwise (never resumed, never another instance's
 * files). The held handle must be the one the ref names.
 */
export async function onManagedInstance<T>(
  ifRunning: SandboxService["ifRunning"],
  task: BackgroundTaskRow,
  fn: (
    bg: SandboxBackground,
    h: SandboxHandle,
    ref: SandboxExecutionRef,
    signal: AbortSignal,
  ) => Promise<T>,
  signal?: AbortSignal,
): Promise<IfRunningResult<T>> {
  const { ref, deviceId, generation } = exactRefOf(task);
  return ifRunning(
    deviceId,
    { createdAt: new Date(generation) },
    async (p, h, sig) => {
      if (h.id !== ref.instanceId)
        throw new SandboxScopeDeniedError(
          "The device's instance does not match the task's recorded execution",
        );
      const bg = p.background;
      if (!bg)
        throw new SandboxPermissionUnsupportedError(
          "Managed background tasks are unavailable on this device",
        );
      return fn(bg, h, ref, sig);
    },
    signal,
  );
}

/** The provider lost supervision of the execution: lost, with the uncertainty retained. */
export const SUPERVISION_LOST: BackgroundFinish = {
  status: "lost",
  lostReason: "supervision_lost",
  killPending: false,
};

function exitedEnd(exitCode: number | null, timedOut: boolean): BackgroundFinish {
  if (timedOut) return { status: "timed_out", exitCode };
  if (exitCode === 0) return { status: "completed", exitCode: 0 };
  return { status: "failed", exitCode };
}

/** How an exact status ends the task, or null while it runs. */
export function statusEnd(s: SandboxExecutionStatus): BackgroundFinish | null {
  if (s.state === "running") return null;
  if (s.state === "lost") return SUPERVISION_LOST;
  return exitedEnd(s.exitCode, s.timedOut);
}

/**
 * How an exact stop ends the task: `already-exited` keeps the natural exit, `stopped` is stopped,
 * `lost` is lost; null for `cancel-pending` (recorded, not applied: no finish yet).
 */
export function stopEnd(r: SandboxStopResult): BackgroundFinish | null {
  if (r.outcome === "already-exited") return exitedEnd(r.exitCode, r.timedOut);
  if (r.outcome === "stopped") return { status: "stopped" };
  if (r.outcome === "lost") return SUPERVISION_LOST;
  return null;
}

/**
 * What a finish summary keeps when the exact tail could not be read: labelled, never mistaken for
 * a task that wrote nothing.
 */
export const LAST_LINES_UNAVAILABLE =
  "[Last lines unavailable: the task's retained output could not be read.]";

/**
 * A finish or stop summary: the exact tail's last 20 lines; null when the retained output is
 * unavailable (lost or expired) or the tail read failed.
 */
export async function lastLinesByRef(
  bg: SandboxBackground,
  h: SandboxHandle,
  ref: SandboxExecutionRef,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const r = await bg.tail(h, ref, { maxBytes: MANAGED_TAIL_BYTES, signal });
    return "unavailable" in r ? null : lastLinesOf(r.data);
  } catch {
    // the end the caller already established stands; only its last lines are missing
    signal.throwIfAborted();
    return null;
  }
}

/** {@link lastLinesByRef}'s answer as a finish event keeps it. */
export const summaryLines = (lines: string | null): string => lines ?? LAST_LINES_UNAVAILABLE;

/** The positional reader of the task's retained output by its exact ref. */
export const readerOf =
  (
    bg: SandboxBackground,
    h: SandboxHandle,
    ref: SandboxExecutionRef,
    signal: AbortSignal,
  ): OutputReader =>
  (offset, maxBytes) =>
    bg.readOutput(h, ref, { offset, maxBytes, signal });
