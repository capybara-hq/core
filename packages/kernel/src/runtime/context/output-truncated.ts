/**
 * A model step cut off at the output token limit (issue #951). The step's `assistant_message`
 * records `stopReason: "max_tokens"`; providers drop a tool call whose arguments were cut off, so
 * nothing of it runs. Request building renders {@link OUTPUT_TRUNCATED_TEXT} as a system message
 * right after such a message: derived from the logged stop reason alone, so a reconstruction
 * renders the same text and no `DriftReason` is needed. The loop then gives the model another
 * step, up to {@link MAX_TRUNCATED_STEPS} truncated steps in a row, after which the run ends with
 * `max_output`.
 */

/** The model-visible text after a step cut off at the output token limit (English). */
export const OUTPUT_TRUNCATED_TEXT =
  "Your previous response was cut off because it reached the output token limit. " +
  "A tool call that was still being written when it was cut off was incomplete and was not run. " +
  "Continue from where the response stopped. Keep each response, including the input of each " +
  "tool call, well under the limit: split long content across several smaller tool calls.";

/**
 * Truncated model steps in a row after which the run ends with `max_output` instead of giving the
 * model another step.
 */
export const MAX_TRUNCATED_STEPS = 3;
