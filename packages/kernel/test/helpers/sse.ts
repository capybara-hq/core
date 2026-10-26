import type { SseMessage } from "@capybara-hq/testing";

export { openSse, type SseClient, type SseMessage } from "@capybara-hq/testing";

/** The data of the stream's `event: ui` frames. */
export const uiFrames = (msgs: SseMessage[]): { plugin: string; contribution: string }[] =>
  msgs.filter((m) => m.event === "ui").map((m) => JSON.parse(m.data as string));
