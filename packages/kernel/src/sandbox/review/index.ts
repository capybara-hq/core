/**
 * Command review, stage 1 (auto-mode spec §5.2): the pure parser and rule table. The kernel
 * service that calls it (and the classifier for `unsure`) lives in Task 6; nothing here touches
 * the database, a model or a lock.
 */
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
