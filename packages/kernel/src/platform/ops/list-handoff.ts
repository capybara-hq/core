import type { HandoffView } from "../operation.js";

/**
 * The link card of a list that holds what a person decides on the web (platform web parity spec
 * §6): the page where it is decided, shown when the list is not empty. `result` is a `pageOf`
 * page; an empty one gets no card.
 */
export const listCard = (
  result: unknown,
  url: string,
  title: { zh: string; en: string },
): HandoffView | null => {
  const items = (result as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  return { kind: "handoff", title, target: { type: "link", url } };
};
