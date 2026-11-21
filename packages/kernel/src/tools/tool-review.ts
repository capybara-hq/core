import { Injectable } from "@nestjs/common";
import type { ReviewHookFacts } from "../sandbox/review/index.js";

/** One tool call addressed to the person that the review model judges under Approve for me (R3). */
export interface ToolReviewInput {
  orgId: string;
  /** Where the person's messages are read and the usage event is written. */
  rootConversationId: string;
  conversationId: string;
  runId: string;
  step: number;
  callId: string;
  accountId: string;
  signal: AbortSignal;
  /** The call's policy key. */
  toolKey: string;
  title: string | null;
  /** The platform's summary of the call, when it has one. */
  summary: { zh: string; en: string } | null;
  input: unknown;
  inputSchema: Record<string, unknown>;
  /** A sub-agent's call: the parent run whose usage the review counts on. */
  parentRunId?: string;
  /** The budget window of the run tree, when known. */
  budgetRunId?: string;
  hookFacts: ReviewHookFacts;
}

/** The review's answer; every failure is `ask` (fail closed). */
export interface ToolReviewVerdict {
  decision: "allow" | "ask" | "deny";
  reason: string;
}

export interface ToolAskReviewer {
  review(input: ToolReviewInput): Promise<ToolReviewVerdict>;
}

/**
 * The tool review on the `review` model purpose (profiles govern every approval, ruling R3). Not
 * provided in a module yet.
 */
@Injectable()
export class ToolAskReview implements ToolAskReviewer {
  async review(_input: ToolReviewInput): Promise<ToolReviewVerdict> {
    throw new Error("ToolAskReview.review is not implemented yet");
  }
}
