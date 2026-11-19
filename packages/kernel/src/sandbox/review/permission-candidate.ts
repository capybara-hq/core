import { isIP } from "node:net";
import path from "node:path";
import {
  DEVICE_DEFAULT_STATE_PATH,
  DEVICE_DENIED_SECRET_PATHS,
  isSandboxWriteDenied,
  type PermissionProfile,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { ApiError } from "../../errors.js";
import { HIDDEN_FORMAT_RE } from "../../text.js";
import { generateImagePaths } from "../../tools/builtins/image/paths.js";
import { hostGrantable } from "../device-sandbox.js";
import { coversHost } from "../modes.js";
import type {
  PermissionCandidate,
  PermissionCandidateResult,
  PermissionCrossingKind,
  PermissionEscalation,
  PermissionExpansion,
  PermissionReviewSnapshot,
} from "../permission-call-types.js";

export type { PermissionCrossingKind };

import { hostsWithinOuter, permissionScopeHash } from "../permission-facts.js";
import { parseCommand } from "./rules.js";

export const withinDirectory = (target: string, root: string): boolean =>
  target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
const sorted = (items: readonly string[]) => [...new Set(items)].sort();
function directory(value: string): string {
  if (
    !value.startsWith("/") ||
    value.length > 4096 ||
    /[\0*?[\]{}]/.test(value) ||
    path.posix.normalize(value) !== value ||
    value === "/"
  )
    throw new ApiError(
      "forbidden",
      "Permission expansion requires an exact bounded directory; use a path inside the project",
    );
  return value;
}
/** Validate the exact presentation and its union with base authority; never truncate or widen. */
export function normalizePermissionExpansion(
  value: PermissionExpansion,
  base: Pick<
    PermissionReviewSnapshot,
    "baseReadDirectories" | "baseWriteDirectories" | "baseHosts"
  >,
): PermissionExpansion {
  const writeDirectories = sorted(value.writeDirectories.map(directory));
  const readDirectories = sorted([...value.readDirectories.map(directory), ...writeDirectories]);
  const hosts = sorted(
    value.hosts.map((host) => {
      const normalized = host.toLowerCase();
      if (normalized !== host || host.includes("*") || validateAllowHost(host).length)
        throw new ApiError(
          "forbidden",
          "Permission expansion requires an exact valid host without wildcards",
        );
      return normalized;
    }),
  );
  if (
    sorted([
      ...base.baseReadDirectories,
      ...base.baseWriteDirectories,
      ...readDirectories,
      ...writeDirectories,
    ]).length > 64 ||
    sorted([...base.baseHosts, ...hosts]).length > 100
  )
    throw new ApiError(
      "forbidden",
      "Permission expansion exceeds the combined limit of 64 directory roots or 100 hosts",
    );
  return { readDirectories, writeDirectories, hosts };
}
export function permissionCandidateHash(
  candidate: Omit<PermissionCandidate, "candidateHash">,
): string {
  return permissionScopeHash(candidate);
}
/** The `Bash` `sandbox` value that asks to run this one call outside the OS sandbox. */
export const SANDBOX_ESCALATED = "escalated";
/** The longest justification an escalated call may give (the tool schema says the same). */
export const ESCALATION_JUSTIFICATION_MAX_CHARS = 500;
/** A background escalation's sentence (empty for a foreground one), for the reason and the review. */
export function escalationBackgroundText(
  escalation: Pick<PermissionEscalation, "background" | "maxSeconds">,
): string {
  if (escalation.background !== true) return "";
  const limit =
    escalation.maxSeconds !== undefined
      ? `, at most ${Math.ceil(escalation.maxSeconds / 60)} minutes`
      : "";
  return ` It starts a background process that keeps running outside the sandbox until it exits or is stopped${limit}.`;
}
/**
 * The agent's justification as one quoted line: line breaks and other control characters become
 * spaces, bidi and other hidden format characters are removed (ZWNJ / ZWJ stay), spaces collapse.
 * It is the agent's text inside a reason written in the kernel's voice, so it is always quoted.
 */
export function quotedJustification(text: string): string {
  const clean = text
    .replace(HIDDEN_FORMAT_RE, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `"${clean}"`;
}
/**
 * What an ask about a per-call sandbox escalation tells the person (and the review model): the
 * crossing, that a background start keeps running outside the sandbox (and for how long at most),
 * the agent's quoted justification and, when the command is also sensitive, that consent too.
 */
export const escalationAskReason = (escalation: PermissionEscalation, sensitive?: string): string =>
  `Run this command outside the sandbox for this call only (full access to the device's files and network).${escalationBackgroundText(escalation)} Justification (from the agent): ${quotedJustification(escalation.justification)}${sensitive ? ` It is also a sensitive command: ${sensitive}` : ""}`;
/** The length of a justification as the tool schema counts it: Unicode code points. */
export const justificationLength = (text: string): number => [...text].length;
/** An escalated call whose justification is over the limit: refused before any review. */
export const ESCALATION_JUSTIFICATION_TOO_LONG_TEXT =
  'This Bash call asked to run outside the sandbox (sandbox: "escalated") with a justification longer than 500 characters, so it did not run. Retry with a justification of one short sentence saying why this command must run outside the sandbox.';
/** Whether a validated call asks to run outside the OS sandbox (only `Bash` can). */
export const isEscalatedCall = (toolKey: string, input: unknown): boolean =>
  toolKey === "Bash" &&
  (input as { sandbox?: unknown } | null | undefined)?.sandbox === SANDBOX_ESCALATED;
/** An escalated call without a usable justification: refused before any review. */
export const ESCALATION_JUSTIFICATION_MISSING_TEXT =
  'This Bash call asked to run outside the sandbox (sandbox: "escalated") without a justification, so it did not run. Retry with justification: one sentence saying why this command must run outside the sandbox, or call Bash without sandbox to run it in the sandbox.';
/** Why an escalation cannot be reviewed: an unattended run (no one can approve it). */
export const ESCALATION_UNATTENDED_WHY =
  "this is an unattended run (a scheduled task) where no one can approve running outside the sandbox";
/** Why an escalation cannot be reviewed: the device, org or platform forbids Full access. */
export const ESCALATION_CEILING_WHY =
  "running commands outside the sandbox is not allowed on this device (its owner, the organization or the platform has not allowed Full access)";
/** Why an escalation cannot be reviewed: the runtime cannot run Full access now. */
export const escalationRuntimeWhy = (reason: string): string =>
  `this device cannot run commands outside its sandbox now (${reason.replace(/\.$/, "")})`;
/** What the model gets when its escalated call cannot be reviewed, with what works instead. */
export const escalationRefusedText = (why: string, workingRoot: string): string =>
  `This Bash call asked to run outside the sandbox, but ${why}, so it did not run. Call Bash without sandbox: "escalated" to run the command inside the sandbox (inside ${workingRoot} and the directories already granted), or ask the user to run it themselves or to allow Full access on this device.`;
/**
 * Appended to a refusal of a restricted `Bash` call (the sandbox or the restricted scope stopped
 * it) when this device and org allow running outside the sandbox: the model may retry the same
 * call escalated, and the profile's approver decides.
 */
export const ESCALATION_RETRY_HINT = ` If this command must reach outside the sandbox, retry the same Bash call with sandbox: "escalated" and justification: one sentence saying why; this conversation's permission profile decides whether it may run outside the sandbox for this call only (the user, the review model, or Full access within this device's limits).`;
/**
 * Who decides a boundary crossing (a per-call escalation, a directory or host proposal) under a
 * profile (2026-11-19 maintainer decision: the profiles are approval policy only): Request approval
 * asks the person, Approve for me asks the review model, Full access asks nobody and grants it
 * for that call within the device's ceiling for running outside the sandbox.
 */
export type PermissionApprover = "person" | "review-model" | "none";
export const approverForProfile = (profile: PermissionProfile): PermissionApprover =>
  profile === "request-approval"
    ? "person"
    : profile === "approve-for-me"
      ? "review-model"
      : "none";
/**
 * The sensitive-command consents that touch credentials (`ask.credential-*`, `ask.ssh`,
 * `ask.secret-file`): an escalation carrying one is reviewed even under Full access.
 */
export const isCredentialConsentRule = (rule: string): boolean =>
  rule.startsWith("ask.credential-") || rule === "ask.ssh" || rule === "ask.secret-file";
/**
 * Who decides one crossing (approval-only profiles design, "Profiles"): {@link approverForProfile},
 * except that an `outside-sandbox` escalation is never auto-granted when a sub-agent asks for it or
 * when it carries a credential consent ({@link isCredentialConsentRule}): `none` becomes
 * `review-model` (maintainer ruling 2026-11-19). Other sensitive consents (sudo, persistent
 * changes) stay automatic under Full access and are recorded.
 */
export function approverForCrossing(input: {
  profile: PermissionProfile;
  crossing: PermissionCrossingKind;
  subAgent: boolean;
  /** The call carries a credential consent (its rule hits; absent: none). */
  credentialConsent?: boolean;
}): PermissionApprover {
  const approver = approverForProfile(input.profile);
  // only the person or the review model approves these escalations, never the agent tree itself
  return approver === "none" &&
    input.crossing === "outside-sandbox" &&
    (input.subAgent || input.credentialConsent === true)
    ? "review-model"
    : approver;
}
/**
 * The crossing a candidate asks for: running one call outside the sandbox, a directory outside the
 * scope (also when hosts come with it), or a new host while the network is an allowlist.
 */
export function crossingOfCandidate(
  candidate: Pick<PermissionCandidate, "scopeKind" | "permissionScope">,
): PermissionCrossingKind {
  if (candidate.scopeKind === "sandbox-escalation") return "outside-sandbox";
  return candidate.permissionScope.readDirectories.length > 0 ||
    candidate.permissionScope.writeDirectories.length > 0
    ? "directory"
    : "host";
}
/** The paths a local device never opens to restricted work, relative to `~`. */
const OWNER_DENIED_PATHS = [...DEVICE_DENIED_SECRET_PATHS, DEVICE_DEFAULT_STATE_PATH];
/**
 * The owner-denied path (as `~/…`) that `target` is at or under for one of `homes`, if any: the
 * device refuses such a root to every restricted grant, so no approval could make it run.
 */
function ownerDeniedPath(target: string, homes: readonly string[]): string | undefined {
  for (const home of homes)
    for (const denied of OWNER_DENIED_PATHS)
      if (withinDirectory(target, path.posix.join(home, denied.slice(2)))) return denied;
  return undefined;
}
/** How a protected location is still reached: only a Bash call run outside the sandbox, if allowed. */
const protectedReach = (escalationRefusal: string | null | undefined) =>
  escalationRefusal
    ? ` Running a command outside the sandbox is not possible here (${escalationRefusal}).`
    : ' If it must be used, only a Bash call run outside the sandbox (sandbox: "escalated" with a justification) can reach it, for that call only and as this conversation\'s permission profile decides.';
const ownerDeniedText = (denied: string, target: string, escalationRefusal?: string | null) =>
  `${target} is under ${denied}, which the device never opens to sandboxed work (a credential location or the device's own state), so this call cannot be approved and did not run. Ask the user to provide what is needed from it.${protectedReach(escalationRefusal)}`;
const protectedWriteText = (target: string, escalationRefusal?: string | null) =>
  `${target} is a protected location the sandbox never writes (shell startup files, git hooks and configuration, and the places the system runs programs from later), so no directory approval covers it and this call did not run. Keep the change inside the project, or ask the user to make it.${protectedReach(escalationRefusal)}`;
/** A refusal of a protected location: never proposed, and its text already names the escalation. */
class ProtectedPathError extends Error {}
/**
 * A background escalation's disclosure: it starts a process that keeps running outside the
 * sandbox until it exits or is stopped, at most the task's deadline (the requested timeout
 * lowered to the background maximum, as the launch computes it). Empty for a foreground call.
 */
function backgroundOf(
  input: unknown,
  maxSeconds: number | undefined,
): { background?: true; maxSeconds?: number } {
  const i = input as { run_in_background?: unknown; timeout?: unknown } | null;
  if (i?.run_in_background !== true) return {};
  if (maxSeconds === undefined || !(maxSeconds > 0)) return { background: true };
  const maxMs = maxSeconds * 1000;
  const requested = typeof i.timeout === "number" && i.timeout > 0 ? i.timeout : maxMs;
  return {
    background: true,
    maxSeconds: Math.max(1, Math.ceil(Math.min(requested, maxMs) / 1000)),
  };
}
/**
 * Why a per-call grant for `host` is unavailable under `facts`, naming who can add it, or null when
 * it is grantable: the device sandbox's host ceiling (`device-sandbox.ts` `hostGrantRefusal`), the
 * one rule the candidate builder, grant issuance and admission read. Facts without the ceiling
 * (built outside admission) fall back to `policy.network`.
 */
export function perCallHostRefusal(facts: PermissionReviewSnapshot, host: string): string | null {
  if (facts.hostRefusal) return facts.hostRefusal(host);
  if ((facts.network ?? "none") === "none")
    return "network access is turned off for this device's sandbox";
  const grantable = facts.hostCeiling
    ? hostGrantable(facts.hostCeiling, host)
    : facts.policy.network.kind === "open-public" ||
      facts.policy.network.hosts.some((pattern) => coversHost(pattern, host));
  return grantable ? null : "it is beyond the device's network limits";
}
/** The exact call binding of a candidate: server identity from the facts, the call's own digests. */
function bindingOf(
  call: { toolKey: string; specHash: string; rawInput: unknown; validatedInput: unknown },
  facts: PermissionReviewSnapshot,
): PermissionCandidate["binding"] {
  return {
    orgId: facts.orgId,
    rootConversationId: facts.rootConversationId,
    conversationId: facts.conversationId,
    deviceId: facts.deviceId,
    accountId: facts.accountId,
    runId: facts.runId,
    callId: facts.callId,
    profile: facts.profile,
    profileRevision: facts.profileRevision,
    scopeRevision: facts.scopeRevision,
    authorityRevision: facts.authorityRevision,
    toolKey: call.toolKey,
    specHash: call.specHash,
    callInputHash: permissionScopeHash(call.rawInput),
    resolvedInputHash: permissionScopeHash(call.validatedInput),
  };
}
/**
 * Extract proposals from the actual validated call. Parsing proposes reach; it never grants it.
 * `homes` are the owner's home candidates (the machine's home, the workspace's home prefix): a
 * call reaching an owner-denied path under one is refused, never proposed.
 */
export function buildPermissionCandidate(
  call: { toolKey: string; specHash: string; rawInput: unknown; validatedInput: unknown },
  facts: PermissionReviewSnapshot,
  homes: readonly (string | null | undefined)[] = [],
  opts: {
    /** The deployment's background task maximum: the most a background escalation may run. */
    backgroundMaxSeconds?: number;
  } = {},
): PermissionCandidateResult {
  const homeRoots = [
    ...new Set(
      homes.filter(
        (h): h is string =>
          typeof h === "string" && h.startsWith("/") && h !== "/" && path.posix.normalize(h) === h,
      ),
    ),
  ];
  const refuseDenied = (target: string) => {
    const denied = ownerDeniedPath(target, homeRoots);
    if (denied)
      throw new ProtectedPathError(ownerDeniedText(denied, target, facts.escalationRefusal));
  };
  // a write proposal never covers a location the sandbox refuses to write (the persistence
  // vectors, git internals): no approval could make it run inside the sandbox
  const refuseWriteDenied = (target: string) => {
    if (isSandboxWriteDenied(target))
      throw new ProtectedPathError(protectedWriteText(target, facts.escalationRefusal));
  };
  const input = call.validatedInput as { file_path?: unknown; command?: unknown } | null;
  // a per-call sandbox escalation: one Bash call with full execution, never a directory or host
  // expansion. Every profile proposes it: the profile only chooses who approves it (Full access
  // grants it within the device's outside-sandbox ceiling, recorded and audited)
  if (isEscalatedCall(call.toolKey, input)) {
    const justification = (input as { justification?: unknown }).justification;
    if (typeof justification !== "string" || justification.trim() === "")
      return {
        kind: "unsupported",
        code: "escalation-unavailable",
        message: ESCALATION_JUSTIFICATION_MISSING_TEXT,
      };
    if (justificationLength(justification) > ESCALATION_JUSTIFICATION_MAX_CHARS)
      return {
        kind: "unsupported",
        code: "escalation-unavailable",
        message: ESCALATION_JUSTIFICATION_TOO_LONG_TEXT,
      };
    if (facts.unattended || facts.escalationRefusal)
      return {
        kind: "unsupported",
        code: "escalation-unavailable",
        message: escalationRefusedText(
          facts.unattended ? ESCALATION_UNATTENDED_WHY : (facts.escalationRefusal as string),
          facts.workingRoot,
        ),
      };
    const candidate = {
      binding: bindingOf(call, facts),
      permissionScope: { readDirectories: [], writeDirectories: [], hosts: [] },
      scopeKind: "sandbox-escalation" as const,
      escalation: { justification, ...backgroundOf(input, opts.backgroundMaxSeconds) },
    };
    return {
      kind: "proposal",
      candidate: Object.freeze({ ...candidate, candidateHash: permissionCandidateHash(candidate) }),
    };
  }
  let targetPath: string | undefined;
  const reads: string[] = [],
    writes: string[] = [],
    hosts: string[] = [];
  const proposeDirectory = (value: string, write: boolean) => {
    const normalized = directory(path.posix.resolve(facts.workingRoot, value));
    refuseDenied(normalized);
    const base = write ? facts.baseWriteDirectories : facts.baseReadDirectories;
    if (!base.some((root) => withinDirectory(normalized, root))) {
      if (write) refuseWriteDenied(normalized);
      (write ? writes : reads).push(normalized);
    }
  };
  // the paths a file call names: `file_path`, or every path a `GenerateImage` call writes into the
  // device (none without `file_path`; the suffixed paths of several images), each judged
  const targets =
    call.toolKey === "GenerateImage"
      ? generateImagePaths(call.validatedInput)
      : ["Read", "Write", "Edit"].includes(call.toolKey) && typeof input?.file_path === "string"
        ? [input.file_path]
        : [];
  try {
    if (targets.length > 0) {
      const write = call.toolKey !== "Read",
        base = write ? facts.baseWriteDirectories : facts.baseReadDirectories;
      for (const target of targets)
        if (target.length > 4096 || /[\0*?[\]{}]/.test(target))
          throw new Error("Invalid target path");
      // a `..` segment proposes nothing: the file tools refuse that path shape themselves. A `.`
      // segment is normalized lexically like any other spelling (`/outside/./x` is `/outside/x`)
      if (targets.some((target) => target.split("/").some((segment) => segment === "..")))
        return { kind: "in-scope" };
      const resolved = targets.map((target) => path.posix.resolve(facts.workingRoot, target));
      // inside the base scope too: the credential consent it would get could never run there
      for (const target of resolved) refuseDenied(target);
      for (const target of resolved) {
        if (!base.some((root) => withinDirectory(target, root))) {
          if (write) refuseWriteDenied(target);
          proposeDirectory(path.posix.dirname(target), write);
        }
      }
      // what the person approves: every path the call writes
      targetPath = resolved.join(", ");
      if (targetPath.length > 4096) throw new Error("Invalid target path");
    } else if (call.toolKey === "Bash" && typeof input?.command === "string") {
      // a host is a crossing only while the sandbox network is not the open one: the open network
      // already reaches every public host, and private ones only outside the sandbox
      const allowlist = facts.network !== "open-public";
      const parsed = parseCommand(input.command);
      for (const command of parsed?.commands ?? []) {
        if (command.argv[0] === "cd" && command.argv.length === 2 && command.argv[1])
          proposeDirectory(command.argv[1], true);
        for (const word of command.argv) {
          if (!allowlist || !/^https?:\/\//i.test(word)) continue;
          const url = new URL(word);
          // an IP literal or a loopback name is no grantable host (no per-call private endpoint
          // grants): nothing is proposed, the enforced network decides and only running outside
          // the sandbox reaches a private address
          const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
          if (
            isIP(hostname.replace(/^\[|\]$/g, "")) !== 0 ||
            hostname === "localhost" ||
            hostname.endsWith(".localhost")
          )
            continue;
          if (
            url.username ||
            url.password ||
            url.hostname.includes("*") ||
            validateAllowHost(url.hostname).length
          )
            throw new Error("Invalid host");
          if (!facts.baseHosts.some((base) => coversHost(base, url.hostname)))
            hosts.push(url.hostname.toLowerCase());
        }
      }
    }
    // a host the applied cloud outer boundary does not cover is unreachable: never proposed,
    // as admission and the recorded context cut it too (B-15)
    const reachable = hostsWithinOuter(hosts, facts.outerNetwork ?? undefined);
    hosts.splice(0, hosts.length, ...reachable);
    if (!reads.length && !writes.length && !hosts.length) return { kind: "in-scope" };
    const permissionScope = normalizePermissionExpansion(
      { readDirectories: reads, writeDirectories: writes, hosts },
      facts,
    );
    if (!facts.broadProjectReach && (reads.length || writes.length))
      throw new Error(
        `This call needs access outside the working directory ${facts.workingRoot} (${[
          ...writes,
          ...reads,
        ].join(
          ", ",
        )}), which the device owner's limits do not allow, so it did not run. Keep the call inside ${facts.workingRoot}, or ask the user to have the device's limits widened.`,
      );
    // a host beyond the per-call host ceiling is never proposed (so never auto-granted): the reply
    // names who can add it
    const refused = hosts.flatMap((host) => {
      const why = perCallHostRefusal(facts, host);
      return why ? [`${host}: ${why}`] : [];
    });
    if (refused.length)
      throw new Error(
        `This call needs network access this device's sandbox cannot be granted per call, so it did not run (${refused.join(
          "; ",
        )}). Run it without those hosts, or ask the user to have the host added.`,
      );
    const candidate = {
      binding: bindingOf(call, facts),
      permissionScope,
      ...(targetPath ? { targetPath } : {}),
      scopeKind: "directories-and-hosts" as const,
    };
    return {
      kind: "proposal",
      candidate: Object.freeze({ ...candidate, candidateHash: permissionCandidateHash(candidate) }),
    };
  } catch (error) {
    if (error instanceof ProtectedPathError)
      return { kind: "unsupported", code: "protected-path", message: error.message };
    return {
      kind: "unsupported",
      code: "unbounded-scope",
      message:
        error instanceof Error
          ? error.message
          : "Use an exact bounded directory inside the project",
    };
  }
}
