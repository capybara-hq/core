import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { type ExecutionClaim, RunExecution } from "../../src/runtime/run-execution.js";
import type { BuiltinCallContext, BuiltinTool } from "../../src/tools/registry.js";
import type { TestKernel } from "./runs.js";

/**
 * Direct builtin calls on the activated tree (permission activation W4): a tool that enters a
 * device goes through the managed operation route, which admits a call only under the current
 * server execution claim of a running run whose log holds the call's `tool_call_started`. These
 * helpers give a test that calls a builtin without the run loop exactly that, as the pipeline
 * does it.
 */

/** A running run of `conversationId` triggered by `accountId`, claimed for execution. */
export async function startClaimedRun(
  k: TestKernel,
  raw: Kysely<unknown>,
  conversationId: string,
  accountId: string,
): Promise<{ runId: string; claim: ExecutionClaim }> {
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const db = kernelDb(raw as Kysely<any>);
  const runId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: conversationId,
      trigger_account_id: accountId,
      status: "running",
      agent_version: 1,
      trigger_seq: 0,
    })
    .execute();
  const claim = await k.app.get(RunExecution).claim(conversationId, runId, randomUUID());
  if (!claim) throw new Error("the run could not be claimed");
  return { runId, claim };
}

/** Appends the canonical `tool_call_started` of `callId` (the pipeline writes it before a call). */
export async function recordCallStarted(
  raw: Kysely<unknown>,
  conversationId: string,
  runId: string,
  callId: string,
  toolKey: string,
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const db = kernelDb(raw as Kysely<any>);
  await db.transaction().execute(async (tx) => {
    const conv = await tx
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const seq = Number(conv.last_seq) + 1;
    await tx
      .insertInto("conversation_events")
      .values({
        conversation_id: conversationId,
        run_id: runId,
        seq,
        type: "tool_call_started",
        payload: JSON.stringify({ callId, toolKey }),
      })
      .execute();
    await tx
      .updateTable("conversations")
      .set({ last_seq: seq })
      .where("id", "=", conversationId)
      .execute();
  });
}

/**
 * Runs `tool` with `input` as the pipeline does: the call's `tool_call_started` in the log of
 * `ctx.conversationId`, then the call under the run's claim fence. `ctx` must carry the claim
 * (`executionClaim`) and its `runId`.
 */
export async function runClaimed(
  k: TestKernel,
  raw: Kysely<unknown>,
  tool: BuiltinTool,
  input: Record<string, unknown>,
  ctx: BuiltinCallContext,
): ReturnType<BuiltinTool["run"]> {
  const claim = ctx.executionClaim;
  if (!claim || !ctx.runId) throw new Error("the call context carries no execution claim");
  await recordCallStarted(raw, ctx.conversationId, ctx.runId, ctx.callId, tool.spec.name);
  return k.app.get(RunExecution).withClaim(
    claim,
    () => true,
    () => tool.run(input, ctx),
  );
}
