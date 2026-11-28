import { isDatabasePort } from "../sandbox/loopback-grant-records.js";
import {
  type ApprovalRecord,
  type LoopbackAskDetail,
  NETWORK_ASK_CANCELLED_NOTE,
} from "./approvals.service.js";

/**
 * Loopback port asks in the tool pipeline (browser loopback port grants): what a device service's
 * reported loopback refusal turns into (a decision by the conversation's permission profile, or a
 * refusal note written at once) and the model-visible notes. Pure: the pipeline reads the facts,
 * writes the grant and the events.
 */

/** `host:port`, an IPv6 literal in brackets. */
const hostPort = (h: string, p: number): string => (h.includes(":") ? `[${h}]:${p}` : `${h}:${p}`);

/** What a reported loopback refusal becomes. */
export type LoopbackPlan =
  /** No loopback entry in the report. */
  | { kind: "none" }
  /** The device's ceilings or its provider refuse a loopback grant now: the note says why. */
  | { kind: "refused"; note: string }
  /** The permission profile decides: grant at once, the review model, or the person. */
  | { kind: "decide"; port: number; host: string; database: boolean };

/**
 * The plan for a call's loopback refusal: `refusal` is why a grant is refused now
 * (`loopbackRefusal`), null when grantable; `escalationAvailable` whether a command of this call
 * could run outside the sandbox (the refusal note then names that remedy).
 */
export function planLoopbackAsk(
  entry: { host: string; port: number } | null,
  refusal: string | null,
  escalationAvailable: boolean,
): LoopbackPlan {
  if (entry === null) return { kind: "none" };
  if (refusal !== null)
    return {
      kind: "refused",
      note: loopbackRefusedNote(entry.host, entry.port, refusal, escalationAvailable),
    };
  return {
    kind: "decide",
    port: entry.port,
    host: entry.host,
    database: isDatabasePort(entry.port),
  };
}

/** Asked: the run waits for the device owner's answer (the call's kept result is written then). */
export const loopbackPendingNote = (host: string, port: number) =>
  `[network] ${hostPort(host, port)} is a local port on the device. The browser reaches local ports only after the port is approved for this conversation; an approval was requested.`;

/** Granted (by Full access, the review model or the person): the call ran again. */
export const loopbackGrantedNote = (port: number) =>
  `Port ${port} on the device was approved for this conversation.`;

/** Not asked: the ceilings or the provider refuse a loopback grant now. */
export const loopbackRefusedNote = (
  host: string,
  port: number,
  why: string,
  escalationAvailable: boolean,
) =>
  `[network] ${hostPort(host, port)} is a local port on the device. Local ports stay closed to the browser because ${why}.${escalationAvailable ? ' A command run outside the sandbox (Bash with sandbox: "escalated") still reaches it.' : ""}`;

/** Asked and declined by the person. */
export const loopbackDeniedNote = (port: number, reason?: string | null) =>
  `[network] Port ${port} on the device was not approved for this conversation, so the browser cannot reach it.${reason ? ` Reason: ${reason}` : ""}`;

/** Asked, no answer within the approval timeout. */
export const loopbackExpiredNote = (port: number, hours: number) =>
  `[network] The approval for port ${port} on the device expired after ${hours} hours without an answer, so the browser cannot reach it.`;

/** Declined by the review model (Approve for me, or a Full access sub-agent). */
export const loopbackReviewDeniedNote = (port: number, reason: string) =>
  `[network] The review declined port ${port} on the device for this conversation: ${reason}`;

/** Asked, the person sent a message instead of answering. */
export const loopbackSkippedNote = (port: number) =>
  `[network] The user sent a message instead of answering, so the browser cannot reach port ${port} on the device.`;

/**
 * The notes of a settled loopback ask (one line per outcome); `hours` is the ask's own wait
 * (created to expiry). Null while it is pending.
 */
export function settledLoopbackNotes(a: ApprovalRecord, hours: number): string[] | null {
  const port = (a.detail as LoopbackAskDetail | null)?.port ?? 0;
  switch (a.status) {
    case "approved":
      return [loopbackGrantedNote(port)];
    case "denied":
      return [loopbackDeniedNote(port, a.denyReason)];
    case "expired":
      return [loopbackExpiredNote(port, hours)];
    case "skipped":
      return [loopbackSkippedNote(port)];
    case "cancelled":
      return [NETWORK_ASK_CANCELLED_NOTE];
    default:
      return null;
  }
}
