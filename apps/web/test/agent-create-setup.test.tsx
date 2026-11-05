import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { renderNewAgent } from "./support/agents";
import { json as apiJson, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
// The page renders without the app frame, which provides the setup context: this file is the
// setup layout (web-order spec §3.8).
vi.mock("../src/components/shell/setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/components/shell/setup")>()),
  useSetup: () => ({ active: true, readiness: undefined, recheck: () => {} }),
}));

const ORG = "/api/v1/orgs/o1";
const CAPS = {
  tools: true,
  vision: false,
  reasoning: false,
  caching: false,
  midConversationSystem: false,
};
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [{ id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [] }],
    },
  ],
};
const created = {
  id: "ag1",
  profile: {
    avatar: { kind: "preset", id: "whale" },
    description: "",
    quickActions: [],
    updatedAt: "2026-11-04T10:00:00.000Z",
  },
};

beforeEach(() => resetNavigation("/agents/new"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/agents/new in the setup layout", () => {
  it("a create lands on a new conversation with the new agent, not its prompt", async () => {
    stubApi({
      [`GET ${ORG}/models`]: () => apiJson(200, MODELS),
      [`POST ${ORG}/agents`]: () => apiJson(201, { agent: created, warnings: [] }),
    });
    await renderNewAgent({ readiness: NOT_READY });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?agent=ag1"));
    expect(router.push).not.toHaveBeenCalledWith("/agents/ag1?s=prompt");
  });
});
