import { DesignProvider, SettingsPage } from "@capybara-hq/design";
import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { loadingSection } from "../src/components/agent/frame";
import { AGENT_SECTIONS, READ_ONLY_FIELDS, SECTION_FIELDS } from "../src/components/agent/sections";
import { agentFormDefaults, renderEditAgent } from "./support/agents";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";
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
    tools: [{ kind: "builtin", name: "AskUserQuestion" }],
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
function routes(a = agent(), over: Record<string, () => Response | Promise<Response>> = {}) {
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
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});
const nav = () => {
  const el = document.querySelector('[data-part="settings-nav"]');
  if (el === null) throw new Error("no section nav");
  return el as HTMLElement;
};
const current = () => nav().querySelector('[aria-current="page"]')?.textContent;
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
/** The head's ⋯ menu (More actions): opens it, reads its items and closes it. */
async function headMenu(): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: en.common.moreActions }));
  const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent ?? "");
  await user.keyboard("{Escape}");
  return items;
}

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
    // 开始对话 stays the primary; 运行记录 and Change owner sit in the ⋯ menu beside it
    expect(await headMenu()).toEqual([en.agents.runHistory, P_.reassign]);
    expect(P_.reassign).toBe("Change owner");
    await view.navigate("/agents/ag1?s=quick-actions");
    expect(current()).toBe(P_.sections["quick-actions"]);
    expect(screen.getByRole("region", { name: P_.sections["quick-actions"] })).toBeTruthy();
    await view.navigate("/agents/ag1?s=tools");
    expect(screen.getByRole("group", { name: en.agents.form.builtinLabel })).toBeTruthy();
    await view.navigate("/agents/ag1?s=nonsense");
    expect(current()).toBe(P_.sections.basics);
  });

  it("read-only quick actions load as item rows in a flush card, as they are drawn", () => {
    const shape = READ_ONLY_FIELDS["quick-actions"] ?? SECTION_FIELDS["quick-actions"];
    render(
      <DesignProvider locale="en">
        <SettingsPage
          header={{ path: [], title: "Helper" }}
          nav={[]}
          activeNav="quick-actions"
          loading={{ sections: [loadingSection("quick-actions", shape, (k) => k)] }}
        />
      </DesignProvider>,
    );
    const card = document.querySelector('[data-part="form-card"]') as HTMLElement;
    expect(card.getAttribute("data-flush")).toBe("true");
    expect(card.querySelectorAll('[data-part="loading-item-row"]')).toHaveLength(2);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
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
    expect(screen.queryByRole("button", { name: en.common.moreActions })).toBeNull();
    expect(screen.queryByText(P_.reassign)).toBeNull();
    await view.navigate("/agents/ag1?s=quick-actions");
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.queryByRole("button", { name: P_.quickActions.add })).toBeNull();
    // one box (acceptance item AB): a flush card of item rows, the action's body in its row
    const qa = screen.getByRole("region", { name: P_.sections["quick-actions"] });
    expect(qa.querySelector('[data-part="form-card"]')?.getAttribute("data-flush")).toBe("true");
    expect(qa.querySelector('[data-part="card"]')).toBeNull();
    const list = within(qa).getByRole("list", { name: P_.quickActions.list });
    expect(list.getAttribute("data-inset")).toBe("flush");
    expect(
      within(screen.getByRole("group", { name: "Summarize" })).getByText("Sum it."),
    ).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    await view.navigate("/agents/ag1?s=model");
    expect(screen.getByText("model-fake / fake-1")).toBeTruthy();
    // a hidden section opens basics
    await view.navigate("/agents/ag1?s=prompt");
    expect(current()).toBe(P_.sections.basics);
    await settle();
    expect(browser).toEqual([]);
  });

  it("landing from a create with a failed avatar upload shows the notice once and clears the query", async () => {
    stubApi(routes());
    window.history.pushState({}, "", "/agents/ag1?s=basics&avatar=failed");
    try {
      await renderEditAgent({ section: "basics" });
      expect(await screen.findByText(P_.createUploadFailed)).toBeTruthy();
      expect(router.replace).toHaveBeenCalledWith("/agents/ag1?s=basics");
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("without the avatar query Basics shows no upload notice and does not navigate", async () => {
    stubApi(routes());
    await renderEditAgent({ section: "basics" });
    await settle();
    expect(screen.queryByText(P_.createUploadFailed)).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
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

  it("a model warning after a basics save is not shown in Basics", async () => {
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
    await vi.waitFor(() => expect(document.querySelector('[data-part="action-row"]')).toBeNull());
    expect(screen.queryByText(en.agents.warnings.fallback_same_provider)).toBeNull();
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

  it("a dirty section asks before any in-app link: discard goes to its href, keep stays", async () => {
    stubApi(routes());
    await renderEditAgent();
    // a link outside the page (the sidebar's) is guarded as well
    const outside = document.createElement("a");
    outside.href = "/skills";
    outside.textContent = "Skills elsewhere";
    document.body.append(outside);
    try {
      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " 2");
      await user.click(outside);
      let dialog = await screen.findByRole("dialog", { name: P_.leave.title });
      await user.click(within(dialog).getByRole("button", { name: P_.leave.keep }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(router.push).not.toHaveBeenCalled();
      // the head's links and the path too
      await user.click(screen.getByRole("link", { name: P_.startChat }));
      dialog = await screen.findByRole("dialog", { name: P_.leave.title });
      await user.click(within(dialog).getByRole("button", { name: P_.leave.keep }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.click(outside);
      dialog = await screen.findByRole("dialog", { name: P_.leave.title });
      await user.click(within(dialog).getByRole("button", { name: P_.leave.discard }));
      expect(router.push).toHaveBeenCalledWith("/skills");
    } finally {
      outside.remove();
    }
  });

  it("a modified click (new tab) is not intercepted", async () => {
    stubApi(routes());
    await renderEditAgent();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " 2");
    const link = within(nav()).getByRole("link", { name: P_.sections.model });
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ...mod });
      // the browser would open a tab: the page must not hold it back
      act(() => {
        link.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    // a plain click is held back
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(true);
    expect(await screen.findByRole("dialog", { name: P_.leave.title })).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a hash-only link, a target=_blank link and a download link are not intercepted", async () => {
    stubApi(routes());
    await renderEditAgent();
    const user = userEvent.setup();
    const name = screen.getByRole("textbox", { name: en.agents.form.nameLabel });
    await user.type(name, " 2");
    const here = `${window.location.pathname}${window.location.search}`;
    const links = [
      { href: "#main" },
      { href: `${here}#section` },
      { href: "/skills", target: "_blank" },
      { href: "/files/report.pdf", download: "" },
    ].map((attrs) => {
      const a = document.createElement("a");
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
      a.textContent = attrs.href;
      document.body.append(a);
      return a;
    });
    try {
      for (const a of links) {
        const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
        act(() => {
          a.dispatchEvent(ev);
        });
        expect(ev.defaultPrevented, a.outerHTML).toBe(false);
        expect(screen.queryByRole("dialog")).toBeNull();
      }
      expect(router.push).not.toHaveBeenCalled();
      expect(name).toHaveProperty("value", "Helper 2");
    } finally {
      for (const a of links) a.remove();
    }
  });

  it("beforeunload asks only while the section is dirty", async () => {
    stubApi(routes());
    await renderEditAgent();
    const unload = () => {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(unload()).toBe(false);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " 2");
    expect(unload()).toBe(true);
    await user.click(screen.getByRole("button", { name: P_.discard }));
    expect(unload()).toBe(false);
  });

  it("the save row shows only with changes; a definition section drops the row and shows no other section's warning", async () => {
    stubApi(
      routes(agent(), {
        [`PATCH ${ORG}/agents/ag1`]: ok({
          agent: agent({ version: 2 }),
          warnings: ["fallback_same_provider"],
        }),
      }),
    );
    const view = await renderEditAgent();
    const row = () => document.querySelector('[data-part="action-row"]');
    expect(row()).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " 2");
    expect(row()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: P_.discard }));
    expect(row()).toBeNull();
    await view.navigate("/agents/ag1?s=tools");
    expect(row()).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: en.agents.form.builtin.SkillWrite }));
    expect(row()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    // saved: the section follows the saved agent, so nothing is left to save
    await vi.waitFor(() => expect(row()).toBeNull());
    expect(screen.queryByRole("button", { name: en.agents.form.continue })).toBeNull();
    expect(screen.queryByText(en.agents.warnings.fallback_same_provider)).toBeNull();
  });

  it("a combined save shows the new profile in the head even when the agent refetch is slow", async () => {
    let profileSaved = false;
    let patched = false;
    stubApi(
      routes(agent(), {
        [`GET ${ORG}/agents/ag1`]: () => {
          // the server's state when the read starts; it answers late
          const snapshot = agent({
            name: patched ? "Helper 2" : "Helper",
            ...(profileSaved ? { description: "New words.", updatedAt: P2 } : {}),
          });
          return new Promise<Response>((r) =>
            setTimeout(() => r(json(200, { agent: snapshot })), 60),
          );
        },
        [`PATCH ${ORG}/agents/ag1/profile`]: () =>
          new Promise<Response>((r) =>
            setTimeout(() => {
              profileSaved = true;
              r(
                json(200, {
                  profile: { ...agent().profile, description: "New words.", updatedAt: P2 },
                }),
              );
            }, 20),
          ) as unknown as Response,
        [`PATCH ${ORG}/agents/ag1`]: () => {
          patched = true;
          return json(200, { agent: agent({ name: "Helper 2" }), warnings: [] });
        },
      }),
    );
    await renderEditAgent();
    const user = userEvent.setup();
    const description = screen.getByRole("textbox", { name: new RegExp(P_.descriptionLabel) });
    await user.clear(description);
    await user.type(description, "New words.");
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), " 2");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(
      () => expect(screen.getByRole("heading", { level: 1, name: "Helper 2" })).toBeTruthy(),
      { timeout: 2000 },
    );
    await settle();
    expect(document.querySelector('[data-part="settings-description"]')?.textContent).toBe(
      "New words.",
    );
  });

  it("a visibility change also invalidates the org's readiness", async () => {
    const calls = stubApi(
      routes(agent(), {
        [`PATCH ${ORG}/agents/ag1`]: ok({
          agent: { ...agent(), visibility: "private" },
          warnings: [],
        }),
      }),
    );
    await renderEditAgent();
    const user = userEvent.setup();
    await pickOption(
      screen.getByRole("combobox", { name: en.agents.form.visibilityLabel }),
      "private",
      user,
    );
    calls.length = 0;
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toContain(
        `${ORG}/readiness`,
      ),
    );
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      visibility: "private",
      expectedVersion: 1,
    });
  });

  it("an upload of another type (gif) says so and uploads nothing", async () => {
    const calls = stubApi(routes());
    const { container } = await renderEditAgent();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    // the accept attribute is a hint: a forced file still reaches the page
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.gif", { type: "image/gif" })] },
    });
    expect(await screen.findByText(P_.uploadType)).toBeTruthy();
    await settle();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("while basics saves its fields are disabled", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const saved = agent();
    stubApi(
      routes(saved, {
        [`PATCH ${ORG}/agents/ag1/profile`]: async () => {
          await held;
          return json(200, { profile: { ...saved.profile, description: "x", updatedAt: P2 } });
        },
      }),
    );
    await renderEditAgent();
    const user = userEvent.setup();
    const description = screen.getByRole("textbox", { name: new RegExp(P_.descriptionLabel) });
    await user.type(description, " more");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(description).toHaveProperty("disabled", true));
    expect(screen.getByRole("textbox", { name: en.agents.form.nameLabel })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("radio", { name: "Fox" })).toHaveProperty("disabled", true);
    await act(async () => release());
    await vi.waitFor(() => expect(description).toHaveProperty("disabled", false));
  });

  it("while quick actions save their fields are disabled", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const saved = agent({ quickActions: [{ title: "T1", body: "B1" }] });
    stubApi(
      routes(saved, {
        [`PATCH ${ORG}/agents/ag1/profile`]: async () => {
          await held;
          return json(200, { profile: { ...saved.profile, updatedAt: P2 } });
        },
      }),
    );
    await renderEditAgent({ section: "quick-actions" });
    const user = userEvent.setup();
    const title = screen.getByRole("textbox", { name: new RegExp(P_.quickActions.titleLabel) });
    await user.type(title, "!");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(title).toHaveProperty("disabled", true));
    expect(screen.getByRole("button", { name: P_.quickActions.add })).toHaveProperty(
      "disabled",
      true,
    );
    await act(async () => release());
    await vi.waitFor(() => expect(title).toHaveProperty("disabled", false));
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
    // the head keeps the loaded row's height: a 40 px block where the avatar will be
    const slot = page.querySelector('[data-part="page-header-avatar"] [data-part="skeleton-box"]');
    expect((slot as HTMLElement | null)?.style.width).toBe("40px");
    expect((slot as HTMLElement | null)?.style.height).toBe("40px");
    // the head's actions the session decides render for real (an owner: run history, reassign
    // and start chat, a static link)
    const actions = page.querySelector('[data-part="page-header-actions"]') as HTMLElement;
    expect(
      within(actions).getByRole("link", { name: en.agents.page.startChat }).getAttribute("href"),
    ).toBe("/chat?agent=ag1");
    // 运行记录 and Change owner: the ⋯ menu, as on the loaded page
    expect(within(actions).getByRole("button", { name: en.common.moreActions })).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByDisplayValue("Summarize")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });
});
