import {
  type DeviceFeature,
  type DeviceLocalPolicySummary,
  type NetworkBlockedHost,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { NETWORK_ASK_MAX_HOSTS, NETWORK_HOST_MAX_CHARS } from "../conversations/events.js";
import type { NetworkRunState } from "../local-devices/network-grants.js";
import {
  networkGrantKey,
  type UnattendedRun,
  unattendedFails,
  unattendedRules,
} from "../schedules/unattended.js";
import { type ApprovalRecord, NETWORK_ASK_CANCELLED_NOTE } from "./approvals.service.js";

/**
 * Network asks in the tool pipeline (network ask-to-allow spec §6.2, §6.6–§6.9, §8.3): what a
 * command's reported refusals turn into (an ask to the device owner, or notes written at once) and
 * the model-visible notes. Pure: the pipeline reads the facts and writes the events.
 */

/** The most network asks one run makes (spec §6.8); later refusals get {@link tooManyNote}. */
export const MAX_NETWORK_ASKS_PER_RUN = 5;

/** The longest kept command result of a network ask, in UTF-8 bytes (spec §6.2). */
export const NETWORK_ASK_KEPT_MAX_BYTES = 16 * 1024;

/** The line a kept result ends with when it had to be clipped to {@link NETWORK_ASK_KEPT_MAX_BYTES}. */
export const NETWORK_ASK_CLIPPED_NOTE =
  "[Output clipped to its first 16 KB while waiting for network access.]";

/** The idempotency key of a call's `network_blocked` event. */
export const networkBlockedIdemKey = (runId: string, callId: string) =>
  `network_blocked:${runId}:${callId}`;

const list = (hosts: readonly string[]) => hosts.join(", ");
const one = (hosts: readonly string[]) => hosts.length === 1;
const pron = (hosts: readonly string[]) => (one(hosts) ? "it" : "them");

/** "x was blocked by this device's network policy." (the lead of every device-layer note). */
const blockedLead = (hosts: readonly string[]) =>
  `[network] ${list(hosts)} ${one(hosts) ? "was" : "were"} blocked by this device's network policy.`;

/** Asked, allowed this time (a run grant; also the 「一直允许」 that fell back to one). */
export const allowedOnceNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts)} The user allowed ${pron(hosts)} for the rest of this task. Run the command again.`;

/** Asked, allowed on the device from now on. */
export const allowedAlwaysNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts)} The user allowed ${pron(hosts)} on this device from now on. Run the command again.`;

/** Asked and declined (also the unchecked hosts of a partial decision, and a host refused earlier in the run). */
export const deniedNote = (hosts: readonly string[], reason?: string | null) =>
  `${blockedLead(hosts)} The user declined access to ${list(hosts)}. Do not try to reach ${pron(hosts)} another way; continue without ${pron(hosts)} or ask the user.` +
  (reason != null && reason !== "" ? ` Reason: ${reason}` : "");

/** Asked, no answer within the approval timeout. */
export const expiredNote = (hosts: readonly string[], hours: number) =>
  `${blockedLead(hosts)} The user did not answer within ${hours}h; access stays blocked.`;

/** Asked, the person sent a message instead (spec §6.7). */
export const skippedNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts)} The user sent a message instead of answering; access stays blocked.`;

/** Asked, the run was stopped before the answer (the note abort writes too). */
export const cancelledNote = (): string => NETWORK_ASK_CANCELLED_NOTE;

/** Not asked: the run tree already waits for another network ask (at most one, spec §6.8). */
export const otherAskPendingNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts).slice(0, -1)}; another network request is waiting for the user.`;

/** Not asked: the run made {@link MAX_NETWORK_ASKS_PER_RUN} asks already (spec §6.8). */
export const tooManyNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts)} Too many network requests in this task; ask the user to allow the domains on the device page.`;

/** The local command that allows each host (one `policy add` per host). */
const localAdd = (hosts: readonly string[]) =>
  hosts.map((h) => `capybara-device policy add allowedDomains ${h}`).join(" and ");

/**
 * Not asked: the device takes no network changes from the deployment (`remoteGrants: off`), so
 * neither a run grant nor 「一直允许」 would reach it; only its owner can allow the host locally.
 */
export const localOnlyNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts).slice(0, -1)}, and this device does not accept network changes from the conversation. The device owner can allow ${pron(hosts)} locally: ${localAdd(hosts)}. Continue without ${pron(hosts)} or tell the user.`;

/**
 * Asked and allowed 「一直允许」, but the device refused the policy op (outcome `refused`): nothing
 * was granted.
 */
export const alwaysRefusedNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts)} The user allowed ${pron(hosts)} on this device, but the device does not accept network changes from the deployment; access stays blocked. The device owner can allow ${pron(hosts)} locally: ${localAdd(hosts)}.`;

/** The org layer (spec §6.6): only an org admin can lift it. */
export const orgLayerNote = (hosts: readonly string[]) =>
  one(hosts)
    ? `[network] ${list(hosts)} is not in the organization's network allowlist. Only an organization admin can add it; the user can ask an admin from the conversation. Continue without it or tell the user.`
    : `[network] ${list(hosts)} are not in the organization's network allowlist. Only an organization admin can add them; the user can ask an admin from the conversation. Continue without them or tell the user.`;

/** The address layer (spec §6.6): nobody can lift it. */
export const addressLayerNote = (hosts: readonly string[]) =>
  one(hosts)
    ? `[network] ${list(hosts)} is a private or local address, which commands can never reach.`
    : `[network] ${list(hosts)} are private or local addresses, which commands can never reach.`;

/**
 * An unattended run (spec §8.1): the task approves the host, yet the device refused it: the device
 * takes no network grants from the deployment (`remoteGrants` off, or a program too old for them).
 * Not asked, not a missing grant: only the device's owner can allow it locally.
 */
export const taskGrantIgnoredNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts)} The scheduled task approves ${pron(hosts)}, but this device does not accept the task's network grants. The device owner can allow ${pron(hosts)} locally: ${localAdd(hosts)}. Continue without ${pron(hosts)}.`;

/** An unattended run in `fail` mode (spec §8.3): no ask, the creator can add a task grant. */
export const unattendedNetworkNote = (hosts: readonly string[]) =>
  `[network] ${list(hosts)} ${one(hosts) ? "is" : "are"} blocked on this device and this scheduled run cannot ask for network access. The task's owner can add ${pron(hosts)} to the task's approved domains. Continue without ${pron(hosts)}.`;

/** What the pipeline knows when a command reported refused hosts. */
export interface NetworkPlanContext {
  /** The device's active machine: its features and local policy summary (null: none connected). */
  device: { features: readonly DeviceFeature[]; policy: DeviceLocalPolicySummary | null } | null;
  /** The scheduled task run the run serves (null / undefined: attended). */
  unattended: UnattendedRun | null | undefined;
}

/** What to do with a command's refused hosts. */
export interface NetworkPlan {
  /** The device-layer hosts to ask the device owner about (empty: no ask). */
  ask: { host: string; port: number }[];
  /** The scopes the ask offers (a device without remote grants is never asked). */
  scopes: ("once" | "always")[];
  /** Notes written now, after the command output (one line per outcome). */
  notes: string[];
  /** `missing_grants` keys of an unattended run (`network:<host>`). */
  missingGrants: string[];
}

/** Hosts in first-seen order, deduplicated, lower-cased, trailing dot dropped. */
function hostsOf(blocked: readonly NetworkBlockedHost[]): NetworkBlockedHost[] {
  const seen = new Set<string>();
  const out: NetworkBlockedHost[] = [];
  for (const b of blocked) {
    const host = b.host.toLowerCase().replace(/\.$/, "");
    if (host === "" || host.length > NETWORK_HOST_MAX_CHARS || seen.has(host)) continue;
    seen.add(host);
    out.push({ ...b, host });
  }
  return out;
}

/** The hosts of a `network_blocked` event: valid, deduplicated, at most {@link NETWORK_ASK_MAX_HOSTS}. */
export function blockedEventHosts(blocked: readonly NetworkBlockedHost[]): NetworkBlockedHost[] {
  return hostsOf(blocked)
    .filter((b) => Number.isInteger(b.port) && b.port >= 1 && b.port <= 65535)
    .slice(0, NETWORK_ASK_MAX_HOSTS);
}

/**
 * Decides what a command's refused hosts become (spec §6.2, §6.8, §6.9, §8.3), given the run
 * tree's network asks (`run`). The caller asks only for foreground `Bash` on a device; this decides
 * the rest:
 * - `address` and `org` layers: a note each (in an unattended run an `org` host is a missing grant);
 *   `unknown`: nothing (the device's trailer explains);
 * - `device` layer on a program without `policyOpId`: nothing (no ask, the trailer explains);
 * - approved by the scheduled task the run serves (`run.taskGranted`) yet refused: a note that
 *   the device ignores the task's grants (never asked, never a missing grant);
 * - refused earlier in the run tree: the denied note; an unattended run in `fail` mode: its note
 *   and a missing grant;
 * - the rest is asked, unless another ask of the run tree is pending or the run made
 *   {@link MAX_NETWORK_ASKS_PER_RUN} asks (a note each).
 */
export function planNetworkAsk(
  blocked: readonly NetworkBlockedHost[],
  run: NetworkRunState | null,
  ctx: NetworkPlanContext,
): NetworkPlan {
  const address: string[] = [];
  const org: string[] = [];
  const refused: string[] = [];
  const localOnly: string[] = [];
  const unattended: string[] = [];
  const taskIgnored: string[] = [];
  const candidates: { host: string; port: number }[] = [];
  const missingGrants: string[] = [];
  // a machine that reports blocked hosts and takes policy changes under op ids (Docker mode has
  // no report; a program without op ids cannot take 「一直允许」)
  const canAsk =
    ctx.device?.features.includes("networkReport") === true &&
    ctx.device.features.includes("policyOpId");
  // no run grant or policy change reaches a device whose owner turned remote grants off
  const remote = ctx.device?.policy?.remoteGrants !== "off";
  for (const b of hostsOf(blocked)) {
    if (b.layer === "address") address.push(b.host);
    else if (b.layer === "org") {
      org.push(b.host);
      if (unattendedRules(ctx.unattended)) missingGrants.push(networkGrantKey(b.host));
    } else if (b.layer === "device") {
      if (!canAsk) continue;
      // relayer already made an invalid name an address; a wildcard is never asked
      if (b.host.startsWith("*.") || validateAllowHost(b.host).length > 0) {
        address.push(b.host);
      } else if (run?.taskGranted?.has(b.host)) taskIgnored.push(b.host);
      else if (run?.refused.has(b.host)) refused.push(b.host);
      else if (unattendedFails(ctx.unattended)) {
        unattended.push(b.host);
        missingGrants.push(networkGrantKey(b.host));
      } else if (!remote) localOnly.push(b.host);
      else candidates.push({ host: b.host, port: b.port });
    }
  }
  const notes: string[] = [];
  if (refused.length > 0) notes.push(deniedNote(refused));
  if (localOnly.length > 0) notes.push(localOnlyNote(localOnly));
  if (taskIgnored.length > 0) notes.push(taskGrantIgnoredNote(taskIgnored));
  if (unattended.length > 0) notes.push(unattendedNetworkNote(unattended));
  let ask: { host: string; port: number }[] = [];
  if (candidates.length > 0) {
    const names = candidates.map((c) => c.host);
    if (run?.pending === true) notes.push(otherAskPendingNote(names));
    else if ((run?.asks ?? 0) >= MAX_NETWORK_ASKS_PER_RUN) notes.push(tooManyNote(names));
    else ask = candidates.slice(0, NETWORK_ASK_MAX_HOSTS);
  }
  if (org.length > 0) notes.push(orgLayerNote(org));
  if (address.length > 0) notes.push(addressLayerNote(address));
  return { ask, scopes: ["once", "always"], notes, missingGrants };
}

/**
 * The note of a settled network ask (spec §6.6): one line per outcome. An approval allows
 * `detail.grantedHosts` (once, always, or once after 「一直允许」 fell back) and declines the hosts
 * left unchecked; `hours` is the ask's own wait (created to expiry). Null while it is pending.
 */
export function settledNetworkNotes(a: ApprovalRecord, hours: number): string[] | null {
  const asked = (a.detail?.hosts ?? []).map((h) => h.host);
  switch (a.status) {
    case "approved": {
      // 「一直允许」 the device refused: nothing took effect (compared as a string: the outcome
      // may predate this build's type)
      if ((a.detail?.outcome as string | undefined) === "refused") {
        return [alwaysRefusedNote(asked)];
      }
      const granted = a.detail?.grantedHosts ?? asked;
      const rest = asked.filter((h) => !granted.includes(h));
      const notes: string[] = [];
      if (granted.length > 0) {
        notes.push(
          a.detail?.outcome === "always" ? allowedAlwaysNote(granted) : allowedOnceNote(granted),
        );
      }
      if (rest.length > 0) notes.push(deniedNote(rest));
      return notes;
    }
    case "denied":
      return [deniedNote(asked, a.denyReason)];
    case "expired":
      return [expiredNote(asked, hours)];
    case "skipped":
      return [skippedNote(asked)];
    case "cancelled":
      return [cancelledNote()];
    default:
      return null;
  }
}

/** `text` followed by `notes` after a blank line (unchanged without notes). */
export const withNetworkNotes = (text: string, notes: readonly string[]): string =>
  notes.length === 0 ? text : `${text}\n\n${notes.join("\n")}`;

/**
 * A kept result's content within {@link NETWORK_ASK_KEPT_MAX_BYTES} (UTF-8): the head, then
 * {@link NETWORK_ASK_CLIPPED_NOTE}. The caller archives large output first, so this rarely cuts.
 */
export function clipKept(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= NETWORK_ASK_KEPT_MAX_BYTES) return content;
  const room = NETWORK_ASK_KEPT_MAX_BYTES - Buffer.byteLength(NETWORK_ASK_CLIPPED_NOTE) - 1;
  // a cut inside a multi-byte character drops it rather than keeping half of it
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, room))
    .replace(/�$/, "");
  return `${head}\n${NETWORK_ASK_CLIPPED_NOTE}`;
}
