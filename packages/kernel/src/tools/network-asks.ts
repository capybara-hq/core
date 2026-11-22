import { type NetworkBlockedHost, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { NETWORK_ASK_MAX_HOSTS, NETWORK_HOST_MAX_CHARS } from "../conversations/events.js";
import { coversHost } from "../sandbox/modes.js";
import type { NetworkRunState } from "../sandbox/network-grants.js";
import { ESCALATION_UNATTENDED_WHY } from "../sandbox/review/permission-candidate.js";
import {
  networkGrantKey,
  type UnattendedRun,
  unattendedFails,
  unattendedRules,
} from "../schedules/unattended.js";
import {
  type ApprovalRecord,
  NETWORK_ASK_CANCELLED_NOTE,
  type NetworkAppliesAt,
} from "./approvals.service.js";

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

/**
 * What a network ask offers (device-provider spec §6.3): only what the device's provider enforces.
 * `once` (a run grant) needs per-operation hosts; `always` adds the hosts to the device's own
 * network list, which takes effect at `appliesAt`.
 */
export interface NetworkAskOffer {
  scopes: ("once" | "always")[];
  appliesAt: NetworkAppliesAt;
}

/**
 * The offer of a network ask on a device (device-provider spec §6.3): with per-operation hosts
 * (`support.perOperationHosts`, an operation boundary) `once`, plus `always` when every asked host
 * may join the device's own list (`listAddable`), applying from the next command; otherwise
 * `always` only, applying the next time the device is used, or after the files are rebuilt when
 * its provider fixes limits at its file system (`limitsApplyAt: "fileSystem"`). Null: nothing to
 * offer (no per-operation hosts and not addable), so the host is never asked about.
 */
export function networkAskOffer(
  support: { perOperationHosts: boolean },
  limitsApplyAt: "instance" | "fileSystem" | undefined,
  listAddable: boolean,
): NetworkAskOffer | null {
  if (support.perOperationHosts)
    return { scopes: listAddable ? ["once", "always"] : ["once"], appliesAt: "next-command" };
  if (!listAddable) return null;
  return {
    scopes: ["always"],
    appliesAt: limitsApplyAt === "fileSystem" ? "files-reset" : "next-use",
  };
}

/** What a device's sandbox says about what a network ask may offer (`SandboxService.hostRefusal`). */
export interface DeviceAskFacts {
  /** Why a per-call grant for a host is unavailable (`hostGrantRefusal`), or null. */
  refusal: (host: string) => string | null;
  /** Why a host cannot join the device's own network list (`deviceListAddRefusal`), or null. */
  listAddRefusal: (host: string) => string | null;
  /** `perCallHosts`: the provider gives each operation its own hosts (an operation boundary). */
  box: { perCallHosts: boolean };
  /** The device's network is an allowlist with a host list of its own. */
  ownList: boolean;
  /** That list's hosts (entries may be `*.` patterns). */
  ownHosts: readonly string[];
  limitsApplyAt: "instance" | "fileSystem" | undefined;
}

/**
 * The plan's `refusal` and `offer` on a device (device-provider spec §6.3). With per-operation
 * hosts a host is offered unless a per-call grant is unavailable; without, unless it cannot join
 * the device's own list (so a host outside the org's effective hosts is never offered). `always`
 * is offered only when the device has a list of its own and every asked host may join it (what
 * `addNetworkHostsIn` accepts), so an offered decision does not fail for that.
 */
export function deviceAskTerms(
  f: DeviceAskFacts,
): Required<Pick<NetworkPlanContext, "refusal" | "offer" | "onList">> {
  const perOperationHosts = f.box.perCallHosts;
  const appliesAt: NetworkAppliesAt = perOperationHosts
    ? "next-command"
    : f.limitsApplyAt === "fileSystem"
      ? "files-reset"
      : "next-use";
  return {
    refusal: perOperationHosts ? f.refusal : f.listAddRefusal,
    // a host the device's own list already names, refused because the instance does not have it
    // yet: it applies when a list edit applies, so it is not asked again
    onList: (host) =>
      f.ownList && f.ownHosts.some((p) => coversHost(p.toLowerCase(), host)) ? appliesAt : null,
    offer: (hosts) =>
      networkAskOffer(
        { perOperationHosts },
        f.limitsApplyAt,
        f.ownList && hosts.length > 0 && hosts.every((h) => f.listAddRefusal(h) === null),
      ),
  };
}

/** When a host added to the device's list applies, as the model reads it. */
const APPLIES_TEXT: Record<NetworkAppliesAt, string> = {
  "next-command": "from the next command",
  "next-use": "the next time the device is used",
  "files-reset": "after the files are rebuilt",
};

/** Asked, allowed this time (a run grant: "once"). */
export const allowedOnceNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts)} The user allowed ${pron(hosts)} for the rest of this task. Run the command again.`;

/**
 * Asked, added to the device's own network list ("always", device-provider spec §6.3): the hosts
 * apply at `appliesAt`, never to the command that asked, which is not run again.
 */
export const addedToDeviceNote = (hosts: readonly string[], appliesAt: NetworkAppliesAt) =>
  `${blockedLead(hosts)} The person added ${list(hosts)} to this device's network list; it applies ${APPLIES_TEXT[appliesAt]}. This command is not run again.`;

/**
 * Not asked: the host is already on the device's own network list (added by an earlier answer or
 * on the device page) and applies at `appliesAt`, not yet to this command (device-provider spec
 * §6.3).
 */
export const onListNote = (hosts: readonly string[], appliesAt: NetworkAppliesAt) =>
  `${blockedLead(hosts)} ${list(hosts)} ${one(hosts) ? "is" : "are"} already on this device's network list; it applies ${APPLIES_TEXT[appliesAt]}. Continue without ${pron(hosts)} until then or tell the user.`;

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

/** The org layer (spec §6.6): only an org admin can lift it. */
export const orgLayerNote = (hosts: readonly string[]) =>
  one(hosts)
    ? `[network] ${list(hosts)} is not in the organization's network allowlist. Only an organization admin can add it; the user can ask an admin from the conversation. Continue without it or tell the user.`
    : `[network] ${list(hosts)} are not in the organization's network allowlist. Only an organization admin can add them; the user can ask an admin from the conversation. Continue without them or tell the user.`;

/** An org-layer host beyond the platform's ceiling (org egress ceiling spec §D2): only a super admin. */
export const platformCeilingNote = (hosts: readonly string[]) =>
  one(hosts)
    ? `[network] ${list(hosts)} is not in the platform's network allowlist, which limits this organization. Only a super admin can add it; organization admins cannot. Continue without it or tell the user.`
    : `[network] ${list(hosts)} are not in the platform's network allowlist, which limits this organization. Only a super admin can add them; organization admins cannot. Continue without them or tell the user.`;

/**
 * The address layer (spec §6.6): no host grant lifts it, only running outside the sandbox. `why`,
 * when running outside the sandbox is not possible for this call, is the escalation refusal's
 * per-layer text (who turns it on, or that an unattended run cannot ask).
 */
export const addressLayerNote = (hosts: readonly string[], why?: string) =>
  `${
    one(hosts)
      ? `[network] ${list(hosts)} is a private or local address.`
      : `[network] ${list(hosts)} are private or local addresses.`
  } Private and local addresses are closed inside the sandbox; only a command run outside the sandbox reaches ${pron(hosts)}${
    why === undefined ? "." : `, but ${why}. Continue without ${pron(hosts)} or tell the user.`
  }`;

/**
 * The address layer under the open sandbox network on a device that allows running outside the
 * sandbox (approval-only profiles design, "Open network"): no host grant reaches a private or
 * local address from the sandbox, only an escalated call does. No network ask is made.
 */
export const addressEscalationNote = (hosts: readonly string[]) =>
  `${
    one(hosts)
      ? `[network] ${list(hosts)} is a private or local address, which the sandbox never reaches.`
      : `[network] ${list(hosts)} are private or local addresses, which the sandbox never reaches.`
  } If the command must reach ${pron(hosts)}, retry the same Bash call with sandbox: "escalated" and justification: one sentence saying why; this conversation's permission profile decides whether it may run outside the sandbox for this call only.`;

/**
 * Whether a private-address block gets {@link addressEscalationNote}: admission's verdict for the
 * call allows escalation (`available`, the source of the Bash tool's own hint: no
 * `escalationRefusal`), and the device runs the open sandbox network (under an allowlist, a host
 * grant is the remedy, not escalation).
 */
export function addressEscalationHint(
  escalation: "available" | "escalated" | undefined,
  networkMode: "open" | "allowlist" | "none",
): boolean {
  return escalation === "available" && networkMode === "open";
}

/**
 * Not asked: a per-call grant for the host is unavailable on this device (approval-only profiles
 * design, "Per-call host grant"), so asking would change nothing; `why` names who can add it
 * (`hostGrantRefusal`): the device owner on the machine, an organization admin or a super admin.
 */
export const unavailableHostNote = (host: string, why: string) =>
  `[network] ${host} was blocked by this device's network policy and cannot be allowed from this conversation: ${why}. Continue without it or tell the user.`;

/**
 * An unattended run (spec §8.1): the task approves the host, yet the device refused it: its
 * provider did not apply the task's network grant. Not asked, not a missing grant: the device's
 * owner adds the host to the device's network list on its page.
 */
export const taskGrantIgnoredNote = (hosts: readonly string[]) =>
  `${blockedLead(hosts)} The scheduled task approves ${pron(hosts)}, but this device did not apply the task's network grant. The device owner can add ${pron(hosts)} to the device's network list on its page. Continue without ${pron(hosts)}.`;

/** An unattended run in `fail` mode (spec §8.3): no ask, the creator can add a task grant. */
export const unattendedNetworkNote = (hosts: readonly string[]) =>
  `[network] ${list(hosts)} ${one(hosts) ? "is" : "are"} blocked on this device and this scheduled run cannot ask for network access. The task's owner can add ${pron(hosts)} to the task's approved domains. Continue without ${pron(hosts)}.`;

/** What the pipeline knows when a command reported refused hosts. */
export interface NetworkPlanContext {
  /**
   * What an ask about `hosts` would offer on the device ({@link networkAskOffer}); null: nothing,
   * so those hosts get an unavailable note. Absent (no device sandbox known): a device-layer host
   * is never asked about.
   */
  offer?: (hosts: string[]) => NetworkAskOffer | null;
  /** The scheduled task run the run serves (null / undefined: attended). */
  unattended: UnattendedRun | null | undefined;
  /**
   * Whether a host is beyond the platform's ceiling (`sandbox.limits.orgHosts: within`, org egress
   * ceiling spec §D2): only a super admin can add it, so its note names the super admin.
   */
  outsideCeiling?: (host: string) => boolean;
  /**
   * Why a host cannot be offered on the device, or null when it may: with per-operation hosts why
   * a per-call grant is unavailable (`hostGrantRefusal`), else why it cannot join the device's own
   * list (`deviceListAddRefusal`). An unavailable host is never asked about; its note names who
   * adds it.
   */
  refusal?: (host: string) => string | null;
  /**
   * When a host the device's own list already names applies there, or null when the list does not
   * name it: such a host is not asked again, its note says when it applies.
   */
  onList?: (host: string) => NetworkAppliesAt | null;
  /**
   * {@link addressEscalationHint}: a private-address block of an attended run answers with the
   * escalation hint.
   */
  escalation?: boolean;
  /**
   * Why this call could not run outside the sandbox (the escalation refusal's per-layer text):
   * a private-address block names who could allow it.
   */
  escalationRefusal?: string;
}

/** What to do with a command's refused hosts. */
export interface NetworkPlan {
  /** The device-layer hosts to ask the device owner about (empty: no ask). */
  ask: { host: string; port: number }[];
  /** What the ask offers (present exactly when `ask` is not empty). */
  offer?: NetworkAskOffer;
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
 *   an `address` host under the open network on a device that allows running outside the sandbox
 *   gets the escalation hint; an `org` host whose grant is unavailable names who adds it;
 *   `unknown`: nothing (the device's trailer explains);
 * - a `device` host that cannot be offered (`ctx.refusal`: beyond the org's or platform's
 *   allowlist ceiling, or on a device without per-operation hosts one its own list cannot take):
 *   a note naming who adds it, never an ask;
 * - `device` layer with no device sandbox known (no `ctx.offer`): nothing (no ask);
 * - a `device` host the device's own list already names (`ctx.onList`: added, not yet applied to
 *   the instance): a note saying when it applies, never asked again;
 * - approved by the scheduled task the run serves (`run.taskGranted`) yet refused: a note that
 *   the device ignores the task's grants (never asked, never a missing grant);
 * - refused earlier in the run tree: the denied note; an unattended run in `fail` mode: its note
 *   and a missing grant;
 * - the rest is asked with `ctx.offer`'s offer (none: an unavailable note each), unless another
 *   ask of the run tree is pending or the run made {@link MAX_NETWORK_ASKS_PER_RUN} asks (a note
 *   each).
 */
export function planNetworkAsk(
  blocked: readonly NetworkBlockedHost[],
  run: NetworkRunState | null,
  ctx: NetworkPlanContext,
): NetworkPlan {
  const address: string[] = [];
  const org: string[] = [];
  const platform: string[] = [];
  const refused: string[] = [];
  const unattended: string[] = [];
  const taskIgnored: string[] = [];
  const candidates: { host: string; port: number }[] = [];
  const missingGrants: string[] = [];
  const unavailable: string[] = [];
  const onList: { host: string; appliesAt: NetworkAppliesAt }[] = [];
  for (const b of hostsOf(blocked)) {
    if (b.layer === "address") address.push(b.host);
    else if (b.layer === "org") {
      const why = ctx.refusal?.(b.host) ?? null;
      if (why !== null) unavailable.push(unavailableHostNote(b.host, why));
      else if (ctx.outsideCeiling?.(b.host) === true) platform.push(b.host);
      else org.push(b.host);
      if (unattendedRules(ctx.unattended)) missingGrants.push(networkGrantKey(b.host));
    } else if (b.layer === "device") {
      if (ctx.offer === undefined) continue;
      const why = ctx.refusal?.(b.host) ?? null;
      // relayer already made an invalid name an address; a wildcard is never asked
      const listed = ctx.onList?.(b.host) ?? null;
      if (b.host.startsWith("*.") || validateAllowHost(b.host).length > 0) {
        address.push(b.host);
      } else if (listed !== null) onList.push({ host: b.host, appliesAt: listed });
      else if (why !== null) unavailable.push(unavailableHostNote(b.host, why));
      else if (run?.taskGranted?.has(b.host)) taskIgnored.push(b.host);
      else if (run?.refused.has(b.host)) refused.push(b.host);
      else if (unattendedFails(ctx.unattended)) {
        unattended.push(b.host);
        missingGrants.push(networkGrantKey(b.host));
      } else candidates.push({ host: b.host, port: b.port });
    }
  }
  const notes: string[] = [];
  if (refused.length > 0) notes.push(deniedNote(refused));
  if (taskIgnored.length > 0) notes.push(taskGrantIgnoredNote(taskIgnored));
  if (unattended.length > 0) notes.push(unattendedNetworkNote(unattended));
  for (const at of ["next-command", "next-use", "files-reset"] as const) {
    const hosts = onList.filter((o) => o.appliesAt === at).map((o) => o.host);
    if (hosts.length > 0) notes.push(onListNote(hosts, at));
  }
  let ask: { host: string; port: number }[] = [];
  let offer: NetworkAskOffer | null = null;
  if (candidates.length > 0) {
    const asked = candidates.slice(0, NETWORK_ASK_MAX_HOSTS);
    const names = candidates.map((c) => c.host);
    offer = ctx.offer?.(asked.map((c) => c.host)) ?? null;
    if (offer === null)
      for (const h of names) unavailable.push(unavailableHostNote(h, NO_OFFER_WHY));
    else if (run?.pending === true) notes.push(otherAskPendingNote(names));
    else if ((run?.asks ?? 0) >= MAX_NETWORK_ASKS_PER_RUN) notes.push(tooManyNote(names));
    else ask = asked;
  }
  notes.push(...unavailable);
  if (org.length > 0) notes.push(orgLayerNote(org));
  if (platform.length > 0) notes.push(platformCeilingNote(platform));
  if (address.length > 0)
    notes.push(
      ctx.escalation === true && ctx.unattended == null
        ? addressEscalationNote(address)
        : addressLayerNote(
            address,
            ctx.unattended != null ? ESCALATION_UNATTENDED_WHY : ctx.escalationRefusal,
          ),
    );
  return { ask, ...(ask.length > 0 && offer !== null && { offer }), notes, missingGrants };
}

/** Why a host is not asked about where nothing can be offered (a device with no own list). */
const NO_OFFER_WHY = "the device's owner changes the device's network on its page";

/**
 * The note of a settled network ask (spec §6.6): one line per outcome. An approval allows
 * `detail.grantedHosts` for the run (`once`) or added them to the device's own list (`always`,
 * applying at `detail.appliesAt`) and declines the hosts left unchecked; `hours` is the ask's own
 * wait (created to expiry). Null while it is pending.
 */
export function settledNetworkNotes(a: ApprovalRecord, hours: number): string[] | null {
  const asked = (a.detail?.hosts ?? []).map((h) => h.host);
  switch (a.status) {
    case "approved": {
      const granted = a.detail?.grantedHosts ?? asked;
      const rest = asked.filter((h) => !granted.includes(h));
      const notes: string[] = [];
      if (granted.length > 0) {
        notes.push(
          a.scope === "always" && a.detail !== null
            ? addedToDeviceNote(granted, a.detail.appliesAt)
            : allowedOnceNote(granted),
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
  return clipKeptWith(content, NETWORK_ASK_CLIPPED_NOTE);
}

/**
 * `content` within {@link NETWORK_ASK_KEPT_MAX_BYTES} (UTF-8): unchanged when it fits, else its
 * head and then `note` on a line of its own (the git asks clip with their own note).
 */
export function clipKeptWith(content: string, note: string): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= NETWORK_ASK_KEPT_MAX_BYTES) return content;
  const room = NETWORK_ASK_KEPT_MAX_BYTES - Buffer.byteLength(note) - 1;
  // a cut inside a multi-byte character drops it rather than keeping half of it
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, room))
    .replace(/�$/, "");
  return `${head}\n${note}`;
}
