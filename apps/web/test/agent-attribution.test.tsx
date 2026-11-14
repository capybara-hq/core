import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { renderEditAgent } from "./support/agents";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/**
 * 提交与 PR 署名 on the agent page (spec 2026-11-14-agent-attribution): 跟随平台 (default) /
 * 自定义 / 关闭, the platform defaults in the help text, the custom inputs and switch, and the
 * read-only state of a viewer who may not change the agent.
 */

const F = en.agents.form;
const ORG = "/api/v1/orgs/o1";
const T = "2026-10-20T08:00:00.000Z";
const PLATFORM_COMMIT = "Co-Authored-By: Capybara <noreply@capybarahq.com>";
const PLATFORM_PR = "🤖 Generated with [Capybara](https://github.com/capybara-hq/core)";

const as = (role: "member" | "owner") => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

const agent = (definition: Record<string, unknown> = {}, ownerAccountId = "a1") => ({
  id: "ag1",
  orgId: "o1",
  ownerAccountId,
  visibility: "org",
  currentVersion: 2,
  profile: { avatar: null, description: "", quickActions: [], updatedAt: T },
  memberIds: null as string[] | null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  definition: {
    name: "Lead",
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    disabledTools: [],
    toolPolicies: {},
    ...definition,
  },
});

const routes = (
  definition: Record<string, unknown> = {},
  ownerAccountId = "a1",
  deployment: Record<string, unknown> = {},
) => {
  const lead = agent(definition, ownerAccountId);
  return {
    calls: stubApi({
      [`GET ${ORG}/settings`]: () =>
        json(200, {
          settings: { toolSearch: "on", locale: "en" },
          deployment: {
            autoMode: { mode: "allowed", source: "default" },
            cloudNetwork: { mode: "open", allowHosts: [] },
            attribution: {
              commit: PLATFORM_COMMIT,
              pr: PLATFORM_PR,
              sessionUrl: false,
            },
            publicUrl: true,
            ...deployment,
          },
          sandboxLimits: { cpu: 1, memoryMb: 1024, source: "deployment" },
        }),
      [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: lead }),
      [`GET ${ORG}/models`]: () =>
        json(200, {
          providers: [
            {
              provider: "model-fake",
              models: [
                {
                  id: "fake-1",
                  displayName: "Fake 1",
                  capabilities: { tools: true, vision: false, reasoning: false },
                  parameters: [],
                },
              ],
            },
          ],
        }),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: lead, warnings: [] }),
    }),
  };
};

const section = () => screen.findByRole("region", { name: F.attributionSection });

beforeEach(() => resetNavigation("/agents/ag1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the agent page's 提交与 PR 署名 section", () => {
  it("follows the platform by default, showing the platform defaults", async () => {
    routes();
    await renderEditAgent({ section: "attribution" });
    const s = await section();
    expect(
      (
        within(s).getByRole("radio", {
          name: new RegExp(F.attributionMode_inherit),
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(within(s).getByText(/Platform defaults: commit/)).toBeTruthy();
    // custom inputs are hidden while following the platform
    expect(within(s).queryByRole("textbox", { name: F.attributionCommit })).toBeNull();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("custom: the inputs and the switch are saved into the definition", async () => {
    const { calls } = routes();
    await renderEditAgent({ section: "attribution" });
    const s = await section();
    const user = userEvent.setup();
    await user.click(within(s).getByRole("radio", { name: new RegExp(F.attributionMode_custom) }));
    const commit = await within(s).findByRole("textbox", { name: F.attributionCommit });
    // prefilled with the platform defaults
    expect((commit as HTMLInputElement).value).toBe(PLATFORM_COMMIT);
    await user.clear(commit);
    await user.type(commit, "Co-Authored-By: Acme <dev@acme.example>");
    await user.click(within(s).getByRole("switch", { name: F.attributionSessionUrl }));
    await user.click(screen.getByRole("button", { name: F.submit }));
    const patch = calls.find((c: Call) => c.method === "PATCH");
    expect(
      (bodyOf(patch) as { definition: { attribution: unknown } }).definition.attribution,
    ).toEqual({
      mode: "custom",
      commit: "Co-Authored-By: Acme <dev@acme.example>",
      pr: PLATFORM_PR,
      sessionUrl: true,
    });
  });

  it("off: saves just the off mode", async () => {
    const { calls } = routes();
    await renderEditAgent({ section: "attribution" });
    const s = await section();
    const user = userEvent.setup();
    await user.click(within(s).getByRole("radio", { name: new RegExp(F.attributionMode_off) }));
    await user.click(screen.getByRole("button", { name: F.submit }));
    const patch = calls.find((c: Call) => c.method === "PATCH");
    expect(
      (bodyOf(patch) as { definition: { attribution: unknown } }).definition.attribution,
    ).toEqual({ mode: "off" });
  });

  it("a viewer who may not change the agent reads the effective values", async () => {
    routes({ attribution: { mode: "custom", commit: "Custom trailer", pr: "Custom PR" } }, "a2");
    await renderEditAgent({ me: as("member"), section: "attribution" });
    const s = await section();
    expect(await within(s).findByText("Custom trailer")).toBeTruthy();
    expect(within(s).getByText("Custom PR")).toBeTruthy();
    expect(within(s).queryByRole("radio")).toBeNull();
    expect(within(s).queryByRole("textbox")).toBeNull();
  });

  it("a requested link shows that no link can be added without a public URL", async () => {
    routes(
      {
        attribution: {
          mode: "custom",
          commit: "Custom trailer",
          pr: "Custom PR",
          sessionUrl: true,
        },
      },
      "a2",
      { publicUrl: false },
    );
    await renderEditAgent({ me: as("member"), section: "attribution" });
    const s = await section();
    expect(await within(s).findByText(F.attributionSessionUrlNeedsPublicUrl)).toBeTruthy();
    expect(within(s).queryByText(F.attributionSessionUrlOn)).toBeNull();
  });

  it("a requested link with a public URL reads Yes", async () => {
    routes({ attribution: { mode: "custom", sessionUrl: true } }, "a2");
    await renderEditAgent({ me: as("member"), section: "attribution" });
    expect(await within(await section()).findByText(F.attributionSessionUrlOn)).toBeTruthy();
  });

  it("an invalid stored mode reads as following the platform on the page too", async () => {
    routes({ attribution: { mode: "bogus", commit: "Should be ignored" } }, "a2");
    await renderEditAgent({ me: as("member"), section: "attribution" });
    const s = await section();
    expect(await within(s).findByText(F.attributionMode_inherit)).toBeTruthy();
    expect(within(s).getByText(PLATFORM_COMMIT)).toBeTruthy();
    expect(within(s).queryByText("Should be ignored")).toBeNull();
  });

  it("renders in Chinese with the zh copy", async () => {
    routes();
    await renderEditAgent({ locale: "zh", section: "attribution" });
    expect(
      await screen.findByRole("region", { name: zh.agents.form.attributionSection }),
    ).toBeTruthy();
    expect(zh.agents.form.attributionMode_inherit).toBe("跟随平台");
  });
});
