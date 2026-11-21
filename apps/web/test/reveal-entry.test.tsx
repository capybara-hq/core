import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { RevealEntry } from "../src/components/conversation/Thread";
import type { TimelineEntry } from "../src/lib/timeline";
import { json, stubApi } from "./support/api";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Reveal = Extract<TimelineEntry, { kind: "reveal" }>;
const entry = (starterAccountId?: string): Reveal => ({
  kind: "reveal",
  key: "k:reveal",
  callId: "call_1",
  runId: "r1",
  reveal: "initial_password",
  ...(starterAccountId !== undefined ? { starterAccountId } : {}),
});
const show = en.approval.initialPassword.show;
const ROUTE = "POST /api/v1/orgs/o1/conversations/c1/runs/r1/calls/call_1/initial-password";

describe("RevealEntry: only the run's person", () => {
  it("the starter sees the button and it calls the call-keyed route", async () => {
    const calls = stubApi({
      [ROUTE]: () =>
        json(200, { accountId: "acc9", login: "alice", password: "Gen3ratedPassw0rd" }),
    });
    renderPage(<RevealEntry orgId="o1" conversationId="c1" entry={entry(ME.account.id)} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: show }));
    expect(await screen.findByLabelText(/alice/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("another account sees nothing", () => {
    stubApi({});
    renderPage(<RevealEntry orgId="o1" conversationId="c1" entry={entry("someone-else")} />);
    expect(screen.queryByRole("button", { name: show })).toBeNull();
  });

  it("an unknown starter sees nothing", () => {
    stubApi({});
    renderPage(<RevealEntry orgId="o1" conversationId="c1" entry={entry()} />);
    expect(screen.queryByRole("button", { name: show })).toBeNull();
  });
});
