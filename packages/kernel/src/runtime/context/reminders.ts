/** 距本轮步数上限还剩几步时开始提醒。 */
const TURN_LIMIT_LEAD = 2;

/**
 * 轮次收尾的尾部提醒：`step >= maxSteps - 2` 时返回英文软提醒，否则 null。
 * 调用方先把它写成 `reminder` 事件，再由 `buildModelRequest` 按事件重建进请求。
 */
export function turnLimitReminder(step: number, maxSteps: number): string | null {
  if (step < maxSteps - TURN_LIMIT_LEAD) return null;
  return `You are close to the step limit for this turn (step ${step} of ${maxSteps}). Wrap up and give the user your best answer now.`;
}

/** 所用模型不支持工具（`capabilities.tools` 为 false）时的提醒（模型可见，英文）。 */
export const TOOLS_UNSUPPORTED_REMINDER =
  "Tools are unavailable for this model. Answer without calling tools.";
