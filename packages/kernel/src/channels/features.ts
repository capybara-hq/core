import {
  type Channel,
  type ChannelCard,
  type ChannelTarget,
  type OutboundMessage,
  renderCardAsText,
} from "@capybara-hq/plugin-sdk";

/** How a channel shows a run's process: a detailed or brief progress card, or none. */
export type ProcessDisplay = "detailed" | "brief" | "off";

/**
 * The effective process display of a connection's chat: the stored setting, else the default by
 * chat type (direct chats detailed, group chats brief).
 */
export function processDisplayOf(v: string | null, chatType: "dm" | "group"): ProcessDisplay {
  if (v === "detailed" || v === "brief" || v === "off") return v;
  return chatType === "dm" ? "detailed" : "brief";
}

/**
 * A run's progress card as the message the channel gets: the native card (titled for the
 * notification preview) only when the plugin declares `features.progress` and `cards`;
 * otherwise its {@link renderCardAsText} text, which the kernel edits in place like the card
 * (process blocks spec §10 Execution rulings: a released plugin without a `progress` branch
 * would throw on it).
 */
export function progressCardMessage(
  features: Channel["features"],
  card: Extract<ChannelCard, { kind: "progress" }>,
  locale: "zh" | "en",
): OutboundMessage {
  // `cards: false` would fall the card back to text after its title: the text alone instead
  if (features.progress === true && features.cards) return { text: card.title, cards: [card] };
  return { text: renderCardAsText(card, locale) };
}

/** `threads: false`: the target loses its `threadId` (the platform has no threads). */
export function adaptTarget(features: Channel["features"], target: ChannelTarget): ChannelTarget {
  if (!features.threads && target.threadId !== undefined) {
    const { threadId: _drop, ...rest } = target;
    return rest;
  }
  return target;
}

/**
 * 按渠道声明的 `features` 调整交给插件的目标与消息（Ruling A33），出站投递与入站回复都经过这里：
 * - `cards: false`：每张卡片按 `renderCardAsText(card, locale)` 退回为文本，以空行分隔拼在正文之后，
 *   消息不再带 `cards`（插件不必自己处理卡片）；退回文本是 Markdown，模型可控的字段在代码里、不会成为链接；
 * - `threads: false`：目标去掉 `threadId`（平台没有话题，回复直接发在 chat 里）。
 * 其余原样返回。
 */
export function adaptToFeatures(
  features: Channel["features"],
  target: ChannelTarget,
  message: OutboundMessage,
  locale: "zh" | "en",
): { target: ChannelTarget; message: OutboundMessage } {
  const t = adaptTarget(features, target);
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
