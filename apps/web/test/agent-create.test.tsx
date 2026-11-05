import { AVATAR_PRESET_IDS } from "@capybara-hq/design";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { renderNewAgent } from "./support/agents";
import { json as apiJson, bodyOf, type Call, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
// the browser's canvas crop and the presigned upload are not in jsdom
vi.mock("../src/lib/avatar-crop", () => ({
  cropAvatar: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
}));
vi.mock("../src/lib/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/attachments")>()),
  uploadToStorage: vi.fn(async () => {}),
}));

const ORG = "/api/v1/orgs/o1";
const P = "2026-11-04T10:00:00.000Z";
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
    {
      provider: "other",
      models: [{ id: "o-1", displayName: "O 1", capabilities: CAPS, parameters: [] }],
    },
  ],
};
const created = {
  id: "ag1",
  profile: {
    avatar: { kind: "preset", id: "whale" },
    description: "",
    quickActions: [],
    updatedAt: P,
  },
};

function stub(extra: Record<string, () => Response | Promise<Response>> = {}) {
  const calls = stubApi({
    [`GET ${ORG}/models`]: () => apiJson(200, MODELS),
    [`POST ${ORG}/agents`]: () => apiJson(201, { agent: created, warnings: [] }),
    ...extra,
  });
  return calls;
}
const posted = (calls: Call[], url: string) =>
  calls.filter((c) => c.method !== "GET" && c.url === `${ORG}${url}`);

beforeEach(() => resetNavigation("/agents/new"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the create form of /agents/new", () => {
  it("create sends the preset, name, model and private, then lands on ?s=prompt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const calls = stub();
    await renderNewAgent();
    const user = userEvent.setup();
    // a random preset is preselected
    const last = AVATAR_PRESET_IDS[AVATAR_PRESET_IDS.length - 1];
    expect((screen.getByRole("radio", { checked: true }) as HTMLInputElement).value).toBe(last);
    // only the short form: no tools, skills, sub-agents, prompt or fallback
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Instructions/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: en.agents.form.visibilityLabel })).toHaveProperty(
      "value",
      "private",
    );
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.agents.form.modelLabel }),
      "other/o-1",
    );
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents/ag1?s=prompt"));
    const sent = posted(calls, "/agents");
    expect(sent).toHaveLength(1);
    // neither `instructions` nor `instructionFiles`: the kernel starts the default AGENTS.md
    expect(bodyOf(sent[0])).toEqual({
      definition: { name: "Echo", model: { provider: "other", model: "o-1" } },
      visibility: "private",
      profile: { avatar: { kind: "preset", id: last } },
    });
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("create without a name is refused", async () => {
    const calls = stub();
    await renderNewAgent();
    const user = userEvent.setup();
    const save = screen.getByRole("button", { name: en.agents.form.submit }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " {Enter}");
    expect(posted(calls, "/agents")).toHaveLength(0);
    const name = screen.getByRole("textbox", { name: en.agents.form.nameLabel });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(en.agents.form.nameRequired)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("the form is a FormPage with one section and no more, name focused, in zh too", async () => {
    stub();
    const { container } = await renderNewAgent({ locale: "zh" });
    expect(container.querySelector('[data-template="FormPage"]')).not.toBeNull();
    expect(screen.getByRole("region", { name: zh.agents.form.basicSection })).toBeTruthy();
    expect(screen.queryByRole("region", { name: zh.agents.form.toolsSection })).toBeNull();
    // the name is the one required field: it has the focus
    const name = screen.getByRole("textbox", { name: zh.agents.form.nameLabel });
    await vi.waitFor(() => expect(document.activeElement).toBe(name));
    const row = screen.getByRole("region", { name: "待提交改动" });
    expect(
      within(row).getByRole("button", { name: zh.agents.form.submit }).getAttribute("data-variant"),
    ).toBe("primary");
    expect(within(row).getByRole("button", { name: zh.common.cancel })).toBeTruthy();
  });

  it("an upload creates with the preset, uploads, saves the profile, then lands on ?s=prompt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const calls = stub({
      [`POST ${ORG}/agents/ag1/avatar/uploads`]: () =>
        apiJson(201, {
          id: "up1",
          upload: { method: "PUT", url: "https://store.example/up1", headers: {} },
          expiresAt: P,
        }),
      [`PATCH ${ORG}/agents/ag1/profile`]: () =>
        apiJson(200, {
          profile: { ...created.profile, avatar: { kind: "upload", uploadId: "up1" } },
        }),
    });
    const { container } = await renderNewAgent();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["x"], "me.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents/ag1?s=prompt"));
    expect((bodyOf(posted(calls, "/agents")[0]) as { profile: unknown }).profile).toEqual({
      avatar: { kind: "preset", id: AVATAR_PRESET_IDS[0] },
    });
    expect(posted(calls, "/agents/ag1/avatar/uploads")).toHaveLength(1);
    expect(bodyOf(posted(calls, "/agents/ag1/profile")[0])).toEqual({
      avatar: { kind: "upload", uploadId: "up1" },
      expectedUpdatedAt: P,
    });
  });

  it("a failed upload after the create still lands on the agent, at Basics with the error", async () => {
    const calls = stub({
      [`POST ${ORG}/agents/ag1/avatar/uploads`]: () =>
        apiJson(503, { error: { code: "storage.unavailable", message: "no store" } }),
    });
    const { container } = await renderNewAgent();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["x"], "me.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/agents/ag1?s=basics&avatar=failed"),
    );
    expect(posted(calls, "/agents")).toHaveLength(1);
    expect(posted(calls, "/agents/ag1/profile")).toHaveLength(0);
  });

  it("picking a preset after an upload drops the upload", async () => {
    const calls = stub();
    const { container } = await renderNewAgent();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["x"], "me.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("radio", { name: /Panda/i }));
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents/ag1?s=prompt"));
    expect((bodyOf(posted(calls, "/agents")[0]) as { profile: unknown }).profile).toEqual({
      avatar: { kind: "preset", id: "panda" },
    });
    expect(posted(calls, "/agents/ag1/avatar/uploads")).toHaveLength(0);
  });
});
