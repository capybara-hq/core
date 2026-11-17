import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
import { PermissionContextSubjectChanged } from "../sandbox/permission-context-types.js";

/** The named no-send failures of a permission context read or append (spec B2 table). */
export const PERMISSION_CONTEXT_RUN_ERRORS = {
  stale: {
    code: "run.permission_context_stale",
    message:
      "Permission configuration changed. Wait for configuration activation, then retry this run.",
  },
  changed: {
    code: "run.permission_context_changed",
    message:
      "The device binding changed while preparing this request. Retry the run after the binding settles.",
  },
  unavailable: {
    code: "run.permission_context_unavailable",
    message:
      "Permission context could not be read or recorded. Retry this run when storage is available.",
  },
  invalid: {
    code: "run.permission_context_invalid",
    message:
      "Permission context is invalid. Ask an administrator to inspect the run before retrying.",
  },
  actor: {
    code: "run.permission_context_actor_unavailable",
    message:
      "This run's actor is no longer authorized. Start a new run with an authorized account.",
  },
} as const;

/** One named no-send failure of the request boundary. */
export type PermissionContextFailureKind = keyof typeof PERMISSION_CONTEXT_RUN_ERRORS;

/** The replica has not applied the current permission configuration (checked under the locks). */
export class PublicationStale extends Error {
  override readonly name = "PublicationStale";
}

/** SQLSTATE classes of a database that is unreachable, overloaded or aborting, not of bad data. */
const STORAGE_SQLSTATE = /^(08|40|53|57|58|XX)[0-9A-Z]{3}$/;
const STORAGE_NODE = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);

/** Whether `error` is a storage failure (database unreachable or aborting), not bad data. */
export function isStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (STORAGE_SQLSTATE.test(code) || STORAGE_NODE.has(code)))
    return true;
  return /Connection terminated|timeout exceeded when trying to connect/i.test(error.message);
}

/**
 * The named kind of a permission context read, append or complete-log refresh failure. The caller
 * has already kept an `ExecutionRevoked`, an abort and a named `RunError` (see
 * {@link permissionContextKindOfCode}); everything else is one of these, never a provider error.
 */
export function permissionContextFailureKind(error: unknown): PermissionContextFailureKind {
  if (error instanceof PublicationStale || error instanceof SandboxScopeDeniedError) return "stale";
  if (error instanceof PermissionContextSubjectChanged) return "changed";
  if (
    error instanceof ApiError &&
    ["conversation.not_found", "forbidden", "org.not_found"].includes(error.code)
  )
    return "actor";
  if (isStorageError(error)) return "unavailable";
  // RecordedPermissionContextError and any unexpected failure
  return "invalid";
}

/** The kind of a named run error code, or undefined for any other code. */
export function permissionContextKindOfCode(
  code: string,
): PermissionContextFailureKind | undefined {
  for (const [kind, v] of Object.entries(PERMISSION_CONTEXT_RUN_ERRORS))
    if (v.code === code) return kind as PermissionContextFailureKind;
  return undefined;
}
