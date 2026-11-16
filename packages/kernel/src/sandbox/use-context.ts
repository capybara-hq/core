import type { SandboxActor } from "@capybara-hq/plugin-sdk";
/** Who uses the sandbox in {@link SandboxService.withSandbox}. */
export interface SandboxUseContext {
  orgId: string;
  deviceId: string;
  /** The agent conversation using it (a sub-agent's own for a child): what it last saw is tracked. */
  holderConversationId: string;
  /** Passed with every `exec` (audit and attribution). */
  actor: SandboxActor;
  /**
   * A use that tells the model nothing (the run-start read of a bound project): it does not mark
   * the holder as having seen the instance, so the holder's next ordinary use still learns that
   * the instance started, restarted or had its files reset ({@link SandboxUseInfo}); what this use
   * itself caused (a creation, a rebuild) is kept for that next use.
   */
  silent?: true;
}
