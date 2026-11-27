// The chat surfaces of the chat-first compact shell (mobile touch plan Task 28, design spec §4.6):
// the home's new conversation and a conversation show the menu button; every other page is pushed.
import { describe, expect, it } from "vitest";
import { isChatSurface } from "../src/lib/chat-surface";

describe("isChatSurface", () => {
  it.each(["/", "/chat/c1", "/chat/9f60c1e6"])("%s is a chat surface", (path) => {
    expect(isChatSurface(path)).toBe(true);
  });

  it.each([
    "/conversations",
    "/inbox",
    "/agents",
    "/chat",
    "/chat/",
    "/chat/c1/x",
    "/automations",
    "/account/profile",
  ])("%s is not", (path) => {
    expect(isChatSurface(path)).toBe(false);
  });
});
