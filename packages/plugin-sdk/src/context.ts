import type { ConversationSource } from "./tool.js";

/**
 * What the kernel passes to a `context@1` provider at the start of a run. The provider returns the
 * text it wants the model to see, or null.
 */
export interface ContextRequest {
  orgId: string;
  /** The run's trigger account (the person whose message started the run). */
  accountId: string;
  agentId: string;
  agentName: string;
  conversationId: string;
  runId: string;
  /** Where the conversation comes from. */
  source: ConversationSource;
  /** The trigger account's role in the org. */
  role: "owner" | "admin" | "member" | "guest";
  /** The account that owns the agent. */
  ownerAccountId: string;
  ownerName: string;
  /** Keys of the tools the agent has in this run. */
  tools: string[];
  /** The provider's effective config for the org. */
  config: unknown;
  /** Aborts when the call runs past {@link CONTEXT_LIMITS}.timeoutMs or the run is aborted. */
  signal: AbortSignal;
}

/** The text a provider adds to the model's context, or null for nothing. */
export type ContextResult = { text: string } | null;

/** The `context@1` contract: an extension that adds text to the model's context at run start. */
export interface ContextProvider {
  provide(req: ContextRequest): Promise<ContextResult>;
}

/** Limits on one `provide` call: the time it may take and the bytes of text the kernel keeps. */
export const CONTEXT_LIMITS = { timeoutMs: 2000, maxBytes: 32768 } as const;
