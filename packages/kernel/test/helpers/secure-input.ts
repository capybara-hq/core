import { expect } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { eventsOf, type Req, waitFor } from "./runs.js";

/**
 * A call with person fields through the pipeline (profiles govern every approval, R4, R5): the
 * consent, when the conversation's profile asks for it, is a tool approval approved here; the
 * values are then submitted on the call's secure input request.
 */

type Requested = Extract<ConversationEvent, { type: "approval_requested" }>;

/** The `nth` (from 0) `approval_requested` of a conversation, once written. */
export const nthApprovalRequested = (db: KernelSchemaDb, convId: string, nth: number) =>
  waitFor(
    async () =>
      (await eventsOf(db, convId)).filter((e): e is Requested => e.type === "approval_requested")[
        nth
      ],
    20_000,
    `approval_requested #${nth + 1}`,
  );

/** The kind of an approval row. */
const kindOf = async (db: KernelSchemaDb, id: string) =>
  (await db.selectFrom("approvals").select("kind").where("id", "=", id).executeTakeFirstOrThrow())
    .kind;

/**
 * Approves the call's consent if it was asked (a tool approval, "once"), then, when `inputs` has
 * values, submits them on the secure input request that follows. Returns the secure input's id
 * and the field paths it asked for (null and [] without one).
 */
export async function consentAndSubmit(
  db: KernelSchemaDb,
  req: Req,
  orgId: string,
  convId: string,
  inputs: Record<string, string>,
): Promise<{ secureInputId: string | null; paths: string[] }> {
  let nth = 0;
  let asked = await nthApprovalRequested(db, convId, nth);
  if ((await kindOf(db, asked.payload.approvalId)) === "tool") {
    const ok = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${asked.payload.approvalId}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    if (Object.keys(inputs).length === 0) return { secureInputId: null, paths: [] };
    nth += 1;
    asked = await nthApprovalRequested(db, convId, nth);
  }
  expect(await kindOf(db, asked.payload.approvalId)).toBe("secure_input");
  const paths = asked.payload.secureInput?.fields ?? [];
  const ok = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${asked.payload.approvalId}/decision`,
    payload: { decision: "approve", inputs },
  });
  expect(ok.statusCode, ok.body).toBe(200);
  return { secureInputId: asked.payload.approvalId, paths: [...paths] };
}
