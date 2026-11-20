import { renderCardAsText } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { personFieldsCard } from "../../src/channels/cards.js";

/**
 * An approval whose Platform call needs the person to type secrets is web-only: IM gets a `bind`
 * card (or its text fallback) linking to the conversation, never an approval card.
 */

const view = (personFields?: unknown[]) => ({
  id: "a1",
  conversationPath: "/chat/c1",
  ...(personFields && { personFields }),
});
const deps = (v: object | null) =>
  ({ db: {} as never, approvals: { describe: async () => v } }) as never;
const fields = [{ key: "apiKey" }, { key: "secret" }];

describe("personFieldsCard", () => {
  it("two person fields: a bind card with the count and the conversation url (zh and en)", async () => {
    expect(await personFieldsCard(deps(view(fields)), "a1", "https://cap.example", "zh")).toEqual({
      kind: "bind",
      text: "需要在网页填写 2 项",
      url: "https://cap.example/chat/c1",
    });
    expect(
      await personFieldsCard(deps(view(fields)), "a1", "https://cap.example", "en"),
    ).toMatchObject({
      text: "2 fields to fill in on the web",
    });
  });

  it("the text fallback carries the line and the url", async () => {
    const card = await personFieldsCard(deps(view(fields)), "a1", "https://cap.example", "zh");
    const text = renderCardAsText(card as NonNullable<typeof card>, "zh");
    expect(text).toContain("需要在网页填写 2 项");
    expect(text).toContain("https://cap.example/chat/c1");
  });

  it("an ordinary approval or a missing one gets no bind card", async () => {
    expect(await personFieldsCard(deps(view()), "a1", "https://cap.example", "en")).toBeUndefined();
    expect(
      await personFieldsCard(deps(view([])), "a1", "https://cap.example", "en"),
    ).toBeUndefined();
    expect(await personFieldsCard(deps(null), "a1", "https://cap.example", "en")).toBeUndefined();
  });
});
