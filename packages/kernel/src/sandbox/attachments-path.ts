import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";

/**
 * Where attachments live in a device: FetchAttachment writes there, and the sandbox service's
 * trusted preparation accepts exactly one conversation's directory (`tools/builtins/sandbox/
 * common.ts` re-exports these).
 */

/** The directory of attachments in the device (each conversation has a subdirectory). */
export const attachmentsRoot = (roots: SandboxRoots): string => `${roots.workspace}/attachments`;
/** {@link attachmentsRoot} of an instance with the default roots. */
export const ATTACHMENTS_ROOT = attachmentsRoot(DEFAULT_SANDBOX_ROOTS);
/**
 * One conversation's attachment directory: the first 12 hex digits of the root conversation's
 * UUID, so conversations sharing a device do not overwrite each other's files.
 */
export const attachmentsDir = (roots: SandboxRoots, rootConversationId: string): string =>
  `${attachmentsRoot(roots)}/${rootConversationId.replaceAll("-", "").slice(0, 12)}`;
