import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { expect } from "vitest";
import { type BackgroundTaskRow, BackgroundTaskStore } from "../../src/background/store.js";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import type { BuiltinTool } from "../../src/tools/registry.js";
import { runClaimed } from "./managed-calls.js";
import type { TestKernel } from "./runs.js";

/**
 * Managed background tasks on the `sandbox-fake` provider (permission activation W4): a task
 * launched through the real `Bash` path, and the fake's record of its execution
 * (`root/instances/<id>/executions/<sha256(operationId)>`: `pgid`, `exit`, `lost`), which tests
 * read instead of the protocol-2 `.sid` / `.exit` files.
 */

/** The fake's directory of the task's execution, on the instance its ref names. */
export function fakeExecutionDir(root: string, t: BackgroundTaskRow): string {
  if (t.instanceId === null || t.operationId === null)
    throw new Error(`task ${t.id} has no managed execution`);
  const hash = createHash("sha256").update(t.operationId).digest("hex");
  return join(root, "instances", t.instanceId, "executions", hash);
}

/** The process group the fake started the task's command in (0 when unknown). */
async function pgidOf(root: string, t: BackgroundTaskRow): Promise<number> {
  return Number(await readFile(join(fakeExecutionDir(root, t), "pgid"), "utf8").catch(() => "0"));
}

/** Whether a process of the task's group still runs. */
export async function fakeExecutionAlive(root: string, t: BackgroundTaskRow): Promise<boolean> {
  const pgid = await pgidOf(root, t);
  if (pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the fake recorded the task's command exit. */
export async function fakeExecutionExited(root: string, t: BackgroundTaskRow): Promise<boolean> {
  return readFile(join(fakeExecutionDir(root, t), "exit"), "utf8").then(
    () => true,
    () => false,
  );
}

/** Kills the task's whole process group from outside the kernel (the supervisor loses it). */
export async function killFakeExecution(root: string, t: BackgroundTaskRow): Promise<void> {
  const pgid = await pgidOf(root, t);
  if (pgid <= 0) throw new Error(`task ${t.id} has no process group`);
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Who launches: the conversation, its actor and the claimed run the call belongs to. */
export interface ManagedLauncher {
  orgId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  /** A sub-agent's root, whose device it uses. */
  sandboxConversationId?: string;
  runId: string;
  claim: ExecutionClaim;
}

/**
 * Starts `command` as a managed background task through the real `Bash` path (the call's
 * `tool_call_started` logged, under the run's claim); returns its row. `seconds` is its timeout.
 */
export async function launchManaged(
  k: TestKernel,
  raw: Kysely<unknown>,
  by: ManagedLauncher,
  command: string,
  seconds = 300,
): Promise<BackgroundTaskRow> {
  const bash = k.app
    .get(BuiltinTools)
    .list()
    .find((t) => t.spec.name === "Bash") as BuiltinTool;
  const r = await runClaimed(
    k,
    raw,
    bash,
    { command, description: `Run ${command}`, run_in_background: true, timeout: seconds * 1000 },
    {
      orgId: by.orgId,
      accountId: by.accountId,
      agentId: by.agentId,
      conversationId: by.conversationId,
      ...(by.sandboxConversationId !== undefined && {
        sandboxConversationId: by.sandboxConversationId,
      }),
      callId: `call-${randomUUID().slice(0, 8)}`,
      runId: by.runId,
      executionClaim: by.claim,
      signal: AbortSignal.timeout(60_000),
    },
  );
  const text = "content" in r ? (r.content[0] as { text: string }).text : "";
  const id = /Started background task (bt_[a-z2-7]{6})/.exec(text)?.[1];
  expect(id, text).toBeDefined();
  return (await k.app.get(BackgroundTaskStore).get(id as string)) as BackgroundTaskRow;
}
