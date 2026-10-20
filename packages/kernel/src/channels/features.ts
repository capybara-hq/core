import {
  type Channel,
  type ChannelTarget,
  type OutboundMessage,
  renderCardAsText,
} from "@capybara-hq/plugin-sdk";

/**
 * 按渠道声明的 `features` 调整交给插件的目标与消息（Ruling A33），出站投递与入站回复都经过这里：
 * - `cards: false`：每张卡片按 `renderCardAsText(card, locale)` 退回为文本，以空行分隔拼在正文之后，
 *   消息不再带 `cards`（插件不必自己处理卡片）；
 * - `threads: false`：目标去掉 `threadId`（平台没有话题，回复直接发在 chat 里）。
 * 其余原样返回。
 */
export function adaptToFeatures(
  features: Channel["features"],
  target: ChannelTarget,
  message: OutboundMessage,
  locale: "zh" | "en",
): { target: ChannelTarget; message: OutboundMessage } {
  let t = target;
  if (!features.threads && target.threadId !== undefined) {
    const { threadId: _drop, ...rest } = target;
    t = rest;
  }
  let m = message;
  if (!features.cards && message.cards !== undefined) {
    const { cards, ...rest } = message;
    const parts = [rest.text, ...cards.map((c) => renderCardAsText(c, locale))].filter(
      (s) => s !== "",
    );
    m = { ...rest, text: parts.join("\n\n") };
  }
  return { target: t, message: m };
}
