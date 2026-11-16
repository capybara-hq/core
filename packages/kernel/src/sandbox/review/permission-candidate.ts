import path from "node:path";
import { validateAllowHost } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../../errors.js";
import { coversHost } from "../modes.js";
import type {
  PermissionCandidate,
  PermissionCandidateResult,
  PermissionExpansion,
  PermissionReviewSnapshot,
} from "../permission-call-types.js";
import { permissionScopeHash } from "../permission-facts.js";
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
/** Extract proposals from the actual validated call. Parsing proposes reach; it never grants it. */
export function buildPermissionCandidate(
  call: { toolKey: string; specHash: string; rawInput: unknown; validatedInput: unknown },
  facts: PermissionReviewSnapshot,
): PermissionCandidateResult {
  const input = call.validatedInput as { file_path?: unknown; command?: unknown } | null;
  let targetPath: string | undefined;
  const reads: string[] = [],
    writes: string[] = [],
    hosts: string[] = [];
  const proposeDirectory = (value: string, write: boolean) => {
    const normalized = directory(path.posix.resolve(facts.workingRoot, value));
    const base = write ? facts.baseWriteDirectories : facts.baseReadDirectories;
    if (!base.some((root) => withinDirectory(normalized, root)))
      (write ? writes : reads).push(normalized);
  };
  try {
    if (["Read", "Write", "Edit"].includes(call.toolKey) && typeof input?.file_path === "string") {
      if (input.file_path.length > 4096 || /[\0*?[\]{}]/.test(input.file_path))
        throw new Error("Invalid target path");
      targetPath = path.posix.resolve(facts.workingRoot, input.file_path);
      const write = call.toolKey !== "Read",
        base = write ? facts.baseWriteDirectories : facts.baseReadDirectories;
      if (!base.some((root) => withinDirectory(targetPath as string, root))) {
        proposeDirectory(path.posix.dirname(targetPath), write);
      }
    } else if (call.toolKey === "Bash" && typeof input?.command === "string") {
      const parsed = parseCommand(input.command);
      for (const command of parsed?.commands ?? []) {
        if (command.argv[0] === "cd" && command.argv.length === 2 && command.argv[1])
          proposeDirectory(command.argv[1], true);
        for (const word of command.argv) {
          if (!/^https?:\/\//i.test(word)) continue;
          const url = new URL(word);
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
    if (!reads.length && !writes.length && !hosts.length) return { kind: "in-scope" };
    const permissionScope = normalizePermissionExpansion(
      { readDirectories: reads, writeDirectories: writes, hosts },
      facts,
    );
    if (
      (!facts.fullAccessCeiling && (reads.length || writes.length)) ||
      hosts.some(
        (host) =>
          facts.policy.network.kind !== "open-public" &&
          !facts.policy.network.hosts.some((pattern) => coversHost(pattern, host)),
      )
    )
      throw new Error("The requested expansion exceeds current owner or organization limits");
    const {
      orgId,
      rootConversationId,
      conversationId,
      deviceId,
      accountId,
      runId,
      callId,
      profile,
      profileRevision,
      scopeRevision,
      authorityRevision,
    } = facts;
    const candidate = {
      binding: {
        orgId,
        rootConversationId,
        conversationId,
        deviceId,
        accountId,
        runId,
        callId,
        profile,
        profileRevision,
        scopeRevision,
        authorityRevision,
        toolKey: call.toolKey,
        specHash: call.specHash,
        callInputHash: permissionScopeHash(call.rawInput),
        resolvedInputHash: permissionScopeHash(call.validatedInput),
      },
      permissionScope,
      ...(targetPath ? { targetPath } : {}),
      scopeKind: "directories-and-hosts" as const,
    };
    return {
      kind: "proposal",
      candidate: Object.freeze({ ...candidate, candidateHash: permissionCandidateHash(candidate) }),
    };
  } catch (error) {
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
