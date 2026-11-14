/**
 * Command review (auto mode spec §5): the pure parser and rule table, the classifier for the
 * `unsure` hits, and the {@link CommandReviewService} the tool pipeline calls for every command in
 * auto mode (and for the file writes outside the workspace). Only the service touches the database,
 * a model or a lock; the parser and the table are pure.
 */

export type {
  ClassifierAnswer,
  ReviewClassifierDeps,
  ReviewClassifierInput,
  ReviewHookFacts,
  RunClassifierArgs,
} from "./classifier.js";
export {
  boundMessages,
  classifierMessage,
  fitReviewInput,
  newReviewTag,
  parseReviewAnswer,
  REVIEW_ASK_REASON,
  REVIEW_MAX_OUTPUT_TOKENS,
  REVIEW_PURPOSE,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TRUNCATED_MARKER,
  REVIEW_UNAVAILABLE_PREFIX,
  reviewSystemPrompt,
  runClassifier,
} from "./classifier.js";
export type { CommandReview, ReviewCall, ReviewInput, ReviewVerdict } from "./review.service.js";
export {
  CommandReviewService,
  REVIEW_REASONS,
} from "./review.service.js";
export {
  parseCommand,
  reviewRules,
  reviewWrite,
} from "./rules.js";
export type {
  ParsedCommand,
  Redirect,
  ReviewFacts,
  ReviewResult,
  RuleHit,
  RuleOutcome,
  SimpleCommand,
} from "./types.js";
export { isSessionGrantableRule } from "./types.js";
