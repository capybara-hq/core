import { describe, expect, it } from "vitest";
import {
  INBOX_ACTIONS_MAX,
  INBOX_LIMITS,
  type InboxAction,
  type InboxPost,
  validateInboxPost,
  validatePermissions,
} from "../src/index.js";

const action = (id: string, over: Partial<InboxAction> = {}): InboxAction => ({
  id,
  label: { zh: "接受", en: "Accept" },
  uiAction: { contribution: "requests", actionId: "accept", payload: { id } },
  ...over,
});

const post = (over: Partial<InboxPost> = {}): InboxPost => ({
  orgId: "o1",
  accountId: "a1",
  kind: "item.assigned",
  title: "CAP-12 was assigned to you",
  ...over,
});

const check = (over: Partial<InboxPost> = {}) => validateInboxPost(post(over), "tracker");

describe("validateInboxPost", () => {
  it("accepts a full item linking to the plugin's own page", () => {
    expect(
      check({
        body: "Export reports as PDF",
        link: "/p/tracker/items?key=CAP-12",
        actions: [action("a"), action("b", { style: "danger" })],
        expiresInSeconds: 3600,
        dedupeKey: "assign-CAP-12",
      }),
    ).toEqual([]);
  });

  it("refuses missing fields, bad kinds and long texts", () => {
    expect(check({ orgId: "", accountId: " ", title: "" })).toEqual([
      "missing_org_id",
      "missing_account_id",
      "missing_title",
    ]);
    expect(check({ kind: "Item:Assigned" })).toEqual(["kind_invalid"]);
    expect(check({ title: "x".repeat(INBOX_LIMITS.titleChars + 1) })).toEqual(["title_too_long"]);
    expect(check({ body: "x".repeat(INBOX_LIMITS.bodyChars + 1) })).toEqual(["body_too_long"]);
  });

  it("links only to /p/<the plugin>/…", () => {
    for (const link of [
      "/p/other/items",
      "/p/tracker/",
      "/p/tracker",
      "/chat/1",
      "https://example.com/p/tracker/x",
      "//evil/p/tracker/x",
      "/p/tracker/../../admin",
      "/p/tracker/a\\b",
    ]) {
      expect(check({ link }), link).toEqual(["link_invalid"]);
    }
    expect(check({ link: "/p/tracker/board#top" })).toEqual([]);
  });

  it(`takes at most ${INBOX_ACTIONS_MAX} actions, each well formed and unique`, () => {
    expect(check({ actions: ["a", "b", "c", "d"].map((id) => action(id)) })).toEqual([
      "too_many_actions",
    ]);
    expect(check({ actions: [action("a"), action("a")] })).toEqual(["action_duplicate"]);
    expect(check({ actions: [action("a", { label: { zh: "", en: "Go" } })] })).toEqual([
      "action_invalid",
    ]);
    expect(
      check({ actions: [action("a", { uiAction: { contribution: "", actionId: "x" } })] }),
    ).toEqual(["action_invalid"]);
    expect(
      check({
        actions: [
          action("a", {
            uiAction: {
              contribution: "c",
              actionId: "x",
              payload: "x".repeat(INBOX_LIMITS.payloadBytes),
            },
          }),
        ],
      }),
    ).toEqual(["payload_too_large"]);
  });

  it("bounds the expiry", () => {
    expect(check({ expiresInSeconds: 0 })).toEqual(["expiry_invalid"]);
    expect(check({ expiresInSeconds: INBOX_LIMITS.maxExpirySeconds + 1 })).toEqual([
      "expiry_invalid",
    ]);
  });
});

describe("permissions.inbox", () => {
  it("is a boolean", () => {
    expect(validatePermissions("tracker", { inbox: true })).toEqual([]);
    expect(validatePermissions("tracker", { inbox: "yes" })).toEqual([
      "permissions.inbox must be a boolean",
    ]);
  });
});
