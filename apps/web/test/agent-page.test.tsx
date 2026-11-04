import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { AGENT_SECTIONS } from "../src/components/agent/sections";
import { agentFormDefaults, renderEditAgent } from "./support/agents";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, sessionRoutes } from "./support/server";

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
const T = "2026-10-20T08:00:00.000Z";
const P = "2026-11-04T10:00:00.000Z";
const P2 = "2026-11-04T11:00:00.000Z";
const P_ = en.agents.page;

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

type QA = { title: string; body: string };
const agent = (
  over: {
    owner?: string;
    quickActions?: QA[];
    description?: string;
    updatedAt?: string;
    name?: string;
    version?: number;
  } = {},
) => ({
  id: "ag1",
  orgId: "o1",
  ownerAccountId: over.owner ?? "a1",
  visibility: "org",
  currentVersion: over.version ?? 1,
  memberIds: null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  profile: {
    avatar: null,
    description: over.description ?? "Helps with notes.",
    quickActions: over.quickActions ?? [],
    updatedAt: over.updatedAt ?? P,
  },
  definition: {
    name: over.name ?? "Helper",
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    tools: [{ kind: "builtin", name: "ask_user" }],
    toolPolicies: {},
    futureField: { keep: true },
  },
});

const ok = (body: unknown) => () => json(200, body);
const limits = (available: boolean) => ({
  types: ["image/png"],
  maxBytes: 1,
  imageMaxBytes: 1,
  maxPerMessage: 1,
  requestMediaBytes: 1,
  available,
});
function routes(a = agent(), over: Record<string, () => Response> = {}) {
  return {
    ...sessionRoutes(),
    ...agentFormDefaults(),
    [`GET ${ORG}/agents/ag1`]: ok({ agent: a }),
    [`GET ${ORG}/models`]: ok(MODELS),
    ...over,
  };
}

const member = (role: "member" | "guest" = "member") => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});
const nav = () => {
  const el = document.querySelector('[data-part="settings-nav"]');
  if (el === null) throw new Error("no section nav");
  return el as HTMLElement;
};
const current = () => nav().querySelector('[aria-current="page"]')?.textContent;
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => resetNavigation("/agents/ag1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the agent page by section (agent profile design §3)", () => {
  it("the section nav lists the 8 sections and opens ?s=…", async () => {
    stubApi(routes());
    const view = await renderEditAgent();
    const links = within(nav()).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(AGENT_SECTIONS.map((s) => P_.sections[s]));
    expect(links.map((l) => l.getAttribute("href"))).toEqual(
      AGENT_SECTIONS.map((s) => `/agents/ag1?s=${s}`),
    );
    expect(current()).toBe(P_.sections.basics);
    // the head: avatar, name, the actions; the template opens the content with the description
    expect(screen.getByRole("heading", { level: 1, name: "Helper" })).toBeTruthy();
    expect(document.querySelector('[data-part="page-header-avatar"]')).not.toBeNull();
    expect(document.querySelector('[data-part="settings-description"]')?.textContent).toBe(
      "Helps with notes.",
    );
    expect(screen.getByRole("link", { name: P_.startChat }).getAttribute("href")).toBe(
      "/chat?agent=ag1",
    );
    expect(screen.getByRole("link", { name: en.agents.runHistory })).toBeTruthy();
    expect(screen.getByRole("button", { name: P_.reassign })).toBeTruthy();
    await view.navigate("/agents/ag1?s=quick-actions");
    expect(current()).toBe(P_.sections["quick-actions"]);
    expect(screen.getByRole("region", { name: P_.sections["quick-actions"] })).toBeTruthy();
    await view.navigate("/agents/ag1?s=tools");
    expect(screen.getByRole("group", { name: en.agents.form.builtinLabel })).toBeTruthy();
    await view.navigate("/agents/ag1?s=nonsense");
    expect(current()).toBe(P_.sections.basics);
  });

  it("a non-editor sees only basics, quick actions and model, read-only", async () => {
    const browser = expectNoFirstPaintFetch();
    const a = agent({ owner: "someone", quickActions: [{ title: "Summarize", body: "Sum it." }] });
    const view = await renderEditAgent({
      routes: { [`GET ${ORG}/agents/ag1`]: ok({ agent: a }) },
      me: member(),
    });
    expect(
      within(nav())
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([P_.sections.basics, P_.sections["quick-actions"], P_.sections.model]);
    expect(screen.getByText(en.agents.readOnly)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload image" })).toBeNull();
    expect(screen.queryByRole("button", { name: en.agents.form.submit })).toBeNull();
    expect(screen.getByRole("link", { name: P_.startChat })).toBeTruthy();
    expect(screen.queryByRole("link", { name: en.agents.runHistory })).toBeNull();
    expect(screen.queryByRole("button", { name: P_.reassign })).toBeNull();
    await view.navigate("/agents/ag1?s=quick-actions");
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.queryByRole("button", { name: P_.quickActions.add })).toBeNull();
    await view.navigate("/agents/ag1?s=model");
    expect(screen.getByText("model-fake / fake-1")).toBeTruthy();
    // a hidden section opens basics
    await view.navigate("/agents/ag1?s=prompt");
    expect(current()).toBe(P_.sections.basics);
    await settle();
    expect(browser).toEqual([]);
  });

  it("saving basics sends the profile and the name, and sends no other section's draft", async () => {
    const saved = agent();
    const calls = stubApi(
      routes(saved, {
        [`PATCH ${ORG}/agents/ag1/profile`]: ok({
          profile: {
            ...saved.profile,
            avatar: { kind: "preset", id: "panda" },
            updatedAt: P2,
          },
        }),
        [`PATCH ${ORG}/agents/ag1`]: ok({ agent: agent({ name: "Helper 2" }), warnings: [] }),
      }),
    );
    await renderEditAgent();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Panda" }));
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " 2");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "PATCH").length).toBe(2));
    const profile = bodyOf(calls.find((c) => c.url.endsWith("/profile")));
    expect(profile).toEqual({ avatar: { kind: "preset", id: "panda" }, expectedUpdatedAt: P });
    const patch = bodyOf(calls.find((c) => c.method === "PATCH" && c.url === `${ORG}/agents/ag1`));
    // the saved definition with the new name: nothing of another section, no visibility
    expect(patch).toEqual({
      definition: { ...saved.definition, name: "Helper 2" },
      expectedVersion: 1,
    });
  });

  it("when one of basics' two saves fails, the other stays saved and the failed part keeps its draft", async () => {
    const saved = agent();
    const calls = stubApi(
      routes(saved, {
        [`PATCH ${ORG}/agents/ag1/profile`]: ok({
          profile: { ...saved.profile, description: "New words.", updatedAt: P2 },
        }),
        [`PATCH ${ORG}/agents/ag1`]: () =>
          json(500, { error: { code: "internal", message: "boom" } }),
      }),
    );
    await renderEditAgent();
    const user = userEvent.setup();
    const description = screen.getByRole("textbox", { name: new RegExp(P_.descriptionLabel) });
    await user.clear(description);
    await user.type(description, "New words.");
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " 2");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(2);
    // the name keeps its draft; the description is the saved one now
    expect(screen.getByRole("textbox", { name: en.agents.form.nameLabel })).toHaveProperty(
      "value",
      "Helper 2",
    );
    expect(description).toHaveProperty("value", "New words.");
    // only the failed part is unsaved
    expect(document.querySelector('[data-part="action-row-unsaved"]')?.textContent).toMatch(
      /\b1\b/,
    );
  });

  it("the kernel's warnings after a basics save show in the section", async () => {
    stubApi(
      routes(agent(), {
        [`PATCH ${ORG}/agents/ag1`]: ok({
          agent: agent({ name: "Helper 2" }),
          warnings: ["fallback_same_provider"],
        }),
      }),
    );
    await renderEditAgent();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " 2");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(await screen.findByText(en.agents.warnings.fallback_same_provider)).toBeTruthy();
  });

  it("leaving a dirty section asks to keep or discard", async () => {
    stubApi(routes());
    await renderEditAgent();
    const user = userEvent.setup();
    const name = screen.getByRole("textbox", { name: en.agents.form.nameLabel });
    await user.type(name, " 2");
    await user.click(within(nav()).getByRole("link", { name: P_.sections.model }));
    let dialog = await screen.findByRole("dialog", { name: P_.leave.title });
    await user.click(within(dialog).getByRole("button", { name: P_.leave.keep }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.push).not.toHaveBeenCalled();
    expect(name).toHaveProperty("value", "Helper 2");
    await user.click(within(nav()).getByRole("link", { name: P_.sections.model }));
    dialog = await screen.findByRole("dialog", { name: P_.leave.title });
    await user.click(within(dialog).getByRole("button", { name: P_.leave.discard }));
    expect(router.push).toHaveBeenCalledWith("/agents/ag1?s=model");
  });

  it("a 409 profile conflict shows the reload action", async () => {
    let reads = 0;
    const calls = stubApi(
      routes(agent(), {
        [`GET ${ORG}/agents/ag1`]: () => {
          reads += 1;
          return json(200, {
            agent: reads > 1 ? agent({ description: "Theirs.", updatedAt: P2 }) : agent(),
          });
        },
        [`PATCH ${ORG}/agents/ag1/profile`]: () =>
          json(409, { error: { code: "agent.profile_conflict", message: "changed" } }),
      }),
    );
    await renderEditAgent();
    const user = userEvent.setup();
    const description = screen.getByRole("textbox", { name: new RegExp(P_.descriptionLabel) });
    await user.type(description, " Mine.");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(await screen.findByText(en.errors.agent.profile_conflict)).toBeTruthy();
    // nothing else was sent: only the profile changed
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.url)).toEqual([
      `${ORG}/agents/ag1/profile`,
    ]);
    await user.click(screen.getByRole("button", { name: P_.reload }));
    await vi.waitFor(() => expect(description).toHaveProperty("value", "Theirs."));
    expect(screen.queryByText(en.errors.agent.profile_conflict)).toBeNull();
  });

  it("quick actions: a 10th cannot be added; reorder; save", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ title: `T${i + 1}`, body: `B${i + 1}` }));
    const saved = agent({ quickActions: eight });
    const calls = stubApi(
      routes(saved, {
        [`PATCH ${ORG}/agents/ag1/profile`]: ok({ profile: { ...saved.profile, updatedAt: P2 } }),
      }),
    );
    await renderEditAgent({ section: "quick-actions" });
    const user = userEvent.setup();
    const add = screen.getByRole("button", { name: P_.quickActions.add });
    await user.click(add);
    expect(add).toHaveProperty("disabled", true);
    // the new (ninth) entry needs its title and body
    const titles = screen.getAllByRole("textbox", { name: new RegExp(P_.quickActions.titleLabel) });
    const bodies = screen.getAllByRole("textbox", { name: new RegExp(P_.quickActions.bodyLabel) });
    expect(titles.length).toBe(9);
    await user.type(titles[8] as HTMLElement, "Plan");
    await user.type(bodies[8] as HTMLElement, "Make a plan.");
    await user.click(screen.getByRole("button", { name: "Move T2 up" }));
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      quickActions: QA[];
      expectedUpdatedAt: string;
    };
    expect(body.quickActions.map((q) => q.title)).toEqual([
      "T2",
      "T1",
      "T3",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8",
      "Plan",
    ]);
    expect(body.quickActions[8]).toEqual({ title: "Plan", body: "Make a plan." });
    expect(body.expectedUpdatedAt).toBe(P);
  });

  it("quick actions: an empty title is refused before the save", async () => {
    const calls = stubApi(routes());
    await renderEditAgent({ section: "quick-actions" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: P_.quickActions.add }));
    await user.type(
      screen.getByRole("textbox", { name: new RegExp(P_.quickActions.bodyLabel) }),
      "Text",
    );
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(await screen.findByText(P_.quickActions.titleRequired)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("no object store: the upload tile explains and a preset saves", async () => {
    const saved = agent();
    const calls = stubApi(
      routes(saved, {
        [`GET ${ORG}/attachments/limits`]: ok(limits(false)),
        [`PATCH ${ORG}/agents/ag1/profile`]: ok({
          profile: { ...saved.profile, avatar: { kind: "preset", id: "fox" }, updatedAt: P2 },
        }),
      }),
    );
    await renderEditAgent();
    expect(screen.getByRole("button", { name: "Upload image" })).toHaveProperty("disabled", true);
    expect(screen.getByText(P_.uploadOff)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Fox" }));
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      avatar: { kind: "preset", id: "fox" },
      expectedUpdatedAt: P,
    });
  });

  it("an upload is cropped, uploaded and saved as an upload avatar; a 503 turns uploading off", async () => {
    const saved = agent();
    const calls = stubApi(
      routes(saved, {
        [`POST ${ORG}/agents/ag1/avatar/uploads`]: ok({
          id: "up1",
          upload: { method: "PUT", url: "https://store.example/up1", headers: {} },
          expiresAt: P2,
        }),
        [`PATCH ${ORG}/agents/ag1/profile`]: ok({
          profile: { ...saved.profile, avatar: { kind: "upload", uploadId: "up1" }, updatedAt: P2 },
        }),
      }),
    );
    const { container } = await renderEditAgent();
    const user = userEvent.setup();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["x"], "me.jpg", { type: "image/jpeg" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    // the cropped png is what is registered
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      contentType: "image/png",
    });
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      avatar: { kind: "upload", uploadId: "up1" },
      expectedUpdatedAt: P,
    });
    cleanup();
    stubApi(
      routes(saved, {
        [`POST ${ORG}/agents/ag1/avatar/uploads`]: () =>
          json(503, { error: { code: "storage.unavailable", message: "no store" } }),
      }),
    );
    const second = await renderEditAgent();
    await user.upload(
      second.container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["x"], "me.png", { type: "image/png" }),
    );
    expect(await screen.findByText(P_.uploadOff)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload image" })).toHaveProperty("disabled", true);
  });

  it("/agents/<id>: a first render from the hydrated cache makes no browser read", async () => {
    const browser = stubApi({});
    await renderEditAgent({ routes: routes() });
    expect(screen.getByRole("textbox", { name: en.agents.form.nameLabel })).toHaveProperty(
      "value",
      "Helper",
    );
    await settle();
    expect(browser.filter((c) => c.method === "GET")).toEqual([]);
  });

  it("/agents/<id>?s=tools: a first render from the hydrated cache makes no browser read", async () => {
    const browser = stubApi({});
    await renderEditAgent({ routes: routes(), section: "tools" });
    expect(screen.getByRole("group", { name: en.agents.form.builtinLabel })).toBeTruthy();
    await settle();
    expect(browser.filter((c) => c.method === "GET")).toEqual([]);
  });

  it("/agents/<id>: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/agents/ag1?s=quick-actions", {
      ...routes(agent({ quickActions: [{ title: "Summarize", body: "Sum it." }] })),
      [`GET ${ORG}/agents/ag1`]: async () => {
        await held;
        return json(200, { agent: agent({ quickActions: [{ title: "Summarize", body: "Sum" }] }) });
      },
    });
    const page = await vi.waitFor(() => {
      const el = document.querySelector('[data-template="SettingsPage"]');
      if (el === null || el.querySelector("[aria-busy='true']") === null)
        throw new Error("no loading page yet");
      return el as HTMLElement;
    });
    // the open section's static frame, as a placeholder, with the nav
    expect(page.querySelectorAll('[data-part="form-section"]').length).toBe(1);
    expect(current()).toBe(P_.sections["quick-actions"]);
    await act(async () => release());
    expect(await screen.findByDisplayValue("Summarize")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });
});
