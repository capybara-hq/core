import { typeBadge } from "@capybara-hq/design";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  DEVICES,
  envView,
  ev,
  FakeEventSource,
  LIMITS,
  MODELS,
  permissionPreview,
  renderChatRoute,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

/**
 * Project files (composer menus §5, plan Task 6): the + menu's Project files row opens the picker
 * on the conversation's device project; chosen files become chips, go out as `projectFiles` and
 * need text like `@` resources; the bubble shows a logged message's project files as chips, never their
 * English blocks.
 */

const params = { conversationId: "c1" };
const search = new URLSearchParams();
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  useSearchParams: () => search,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/conversations/c1`;
const ROOT = "/Users/o/src/core";
const CORE = { name: "core", path: ROOT };
const FILES = `${ORG}/devices/e1/projects/core/files`;

const LISTINGS: Record<string, { name: string; kind: "file" | "dir"; size?: number }[]> = {
  "": [
    { name: "src", kind: "dir" },
    { name: "README.md", kind: "file", size: 120 },
    { name: "package.json", kind: "file", size: 40 },
  ],
  src: [
    { name: "app.ts", kind: "file", size: 900 },
    { name: "util.ts", kind: "file", size: 300 },
  ],
};

/** The listing route: the directory `path`, its names filtered by `q`. */
const listing = (c: Call) => {
  const u = new URL(c.url, "http://x");
  const path = u.searchParams.get("path") ?? "";
  const q = (u.searchParams.get("q") ?? "").toLowerCase();
  const entries = (LISTINGS[path] ?? [])
    .filter((e) => e.name.toLowerCase().includes(q))
    .map((e) => ({ ...e, path: path === "" ? e.name : `${path}/${e.name}` }));
  return json(200, { entries, truncated: false });
};

const fileReads = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.split("?")[0] === FILES).map((c) => c.url);

/** The conversation page for a conversation bound to `core` on e1 (or `project`). */
function chatApi(
  extra: Record<string, (c: Call) => Response | Promise<Response>> = {},
  conv: Record<string, unknown> = { deviceId: "e1", project: CORE },
  events: unknown[] = [userMsg(1, "hi")],
) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV("c1", conv)),
    [`GET ${BASE}/device`]: () => json(200, { device: envView("e1", "Laptop") }),
    [`GET ${BASE}/events`]: () => json(200, { events }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${BASE}/subagents`]: () => json(200, { subagents: [] }),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${FILES}`]: listing,
    ...extra,
  });
}

const input = (m = en) =>
  screen.getByRole("combobox", { name: m.chat.inputLabel, hidden: true }) as HTMLTextAreaElement;
/** The + button (named by the design: Attach files, in zh too). */
const plus = (m = en) =>
  screen.getByRole("button", { name: m === zh ? "添加附件" : "Attach files" });
const sendButton = (m = en) => screen.getByRole("button", { name: m.chat.send });
const projectRow = async (m = en) => {
  await screen.findByRole("listbox");
  return screen.findByRole("option", { name: new RegExp(`^${m.chat.composerMenu.projectFiles}`) });
};
/** The picker's dialog (named by the design's title). */
const picker = (title = "Reference project files") => screen.findByRole("dialog", { name: title });
/** Opens the picker from the + menu, picks the root's `names` and references them. */
async function reference(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  await user.click(plus());
  await user.click(await projectRow());
  const dialog = await picker();
  for (const name of names) await user.click(await within(dialog).findByRole("option", { name }));
  await user.click(within(dialog).getByRole("button", { name: "Reference" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
/** A refusal of the send, as the kernel answers it (422). */
const refusal = (code: string, details: unknown[]) => () =>
  json(422, { error: { code, message: "refused", details } });
const missingText = (path: string) => en.chat.projectFileMissing.replace("{path}", path);

beforeEach(() => {
  params.conversationId = "c1";
  for (const k of [...search.keys()]) search.delete(k);
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("the project file picker", () => {
  it("the + row shows only with a device project", async () => {
    chatApi({}, { deviceId: "e1", project: null });
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus(zh));
    await screen.findByRole("option", { name: zh.chat.composerMenu.upload });
    expect(
      screen.queryByRole("option", { name: new RegExp(`^${zh.chat.composerMenu.projectFiles}`) }),
    ).toBeNull();
  });

  it("opens on the root, navigates folders, filters, keeps a selection across folders and adds chips", async () => {
    const calls = chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus());
    const row = await projectRow();
    expect(row.querySelector('[data-part="icon"]')?.getAttribute("data-icon")).toBe("folder");
    await user.click(row);
    const dialog = await picker();
    // the root is read with no path and no filter
    await within(dialog).findByRole("option", { name: "README.md" });
    expect(fileReads(calls)).toEqual([FILES]);
    await user.click(within(dialog).getByRole("option", { name: "README.md" }));
    await user.click(within(dialog).getByRole("option", { name: "Folder src" }));
    await within(dialog).findByRole("option", { name: "app.ts" });
    expect(fileReads(calls)).toContain(`${FILES}?path=src`);
    // the filter is the directory's `q`
    await user.type(within(dialog).getByRole("searchbox", { name: "Filter this folder" }), "app");
    await vi.waitFor(() => expect(fileReads(calls)).toContain(`${FILES}?path=src&q=app`));
    await vi.waitFor(() =>
      expect(within(dialog).queryByRole("option", { name: "util.ts" })).toBeNull(),
    );
    await user.click(within(dialog).getByRole("option", { name: "app.ts" }));
    await user.click(within(dialog).getByRole("button", { name: "Reference" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const strip = screen.getByRole("group", { name: en.chat.files });
    expect(within(strip).getByText("README.md")).toBeTruthy();
    // the whole path names the chip (src/index.ts and test/index.ts are told apart), no size
    expect(within(strip).getByText("src/app.ts")).toBeTruthy();
    expect(strip.textContent).not.toMatch(/\d\s*B\b/);
    // a chip's × removes it
    await user.click(within(strip).getByRole("button", { name: "Remove README.md" }));
    expect(within(strip).queryByText("README.md")).toBeNull();
    expect(within(strip).getByRole("button", { name: "Remove src/app.ts" })).toBeTruthy();
  });

  it("sends the paths as projectFiles; without text send is disabled with the hint", async () => {
    const calls = chatApi({
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "x") }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus());
    await user.click(await projectRow());
    const dialog = await picker();
    await user.click(await within(dialog).findByRole("option", { name: "README.md" }));
    await user.click(within(dialog).getByRole("button", { name: "Reference" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    // the hint stands in the empty input (the composer's placeholder)
    expect(input().getAttribute("placeholder")).toBe(en.chat.referencesNeedText);
    await user.type(input(), "read it{Enter}");
    const post = calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    expect(post).toHaveLength(1);
    expect(bodyOf(post[0])).toMatchObject({
      text: "read it",
      projectFiles: [{ path: "README.md" }],
    });
    // the chips leave with the message
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull());
  });

  it("a refused path stays as a chip that says it is gone", async () => {
    chatApi({
      [`POST ${BASE}/messages`]: () =>
        json(422, {
          error: {
            code: "conversation.project_file_unavailable",
            message: "README.md is not a file in the project core; pick it again",
            details: [{ path: "README.md" }],
          },
        }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus());
    await user.click(await projectRow());
    const dialog = await picker();
    await user.click(await within(dialog).findByRole("option", { name: "README.md" }));
    await user.click(within(dialog).getByRole("button", { name: "Reference" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.type(input(), "read it{Enter}");
    expect(
      await screen.findByText(en.chat.projectFileMissing.replace("{path}", "README.md")),
    ).toBeTruthy();
    expect(input().value).toBe("read it");
  });

  it("the + row is hidden on someone else's conversation (the listing is the owner's)", async () => {
    chatApi({}, { deviceId: "e1", project: CORE, accountId: "a2" });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus());
    await screen.findByRole("option", { name: en.chat.composerMenu.upload });
    expect(
      screen.queryByRole("option", { name: new RegExp(`^${en.chat.composerMenu.projectFiles}`) }),
    ).toBeNull();
  });

  it("opening a folder with a filter reads it unfiltered at once", async () => {
    const calls = chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus());
    await user.click(await projectRow());
    const dialog = await picker();
    await within(dialog).findByRole("option", { name: "README.md" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Filter this folder" }), "sr");
    await vi.waitFor(() => expect(fileReads(calls)).toContain(`${FILES}?q=sr`));
    await user.click(await within(dialog).findByRole("option", { name: "Folder src" }));
    await within(dialog).findByRole("option", { name: "util.ts" });
    expect(fileReads(calls)).toContain(`${FILES}?path=src`);
    expect(fileReads(calls).some((u) => u.includes("path=src&q="))).toBe(false);
  });

  it("each opening starts on the root, not the last folder", async () => {
    const calls = chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus());
    await user.click(await projectRow());
    let dialog = await picker();
    await user.click(await within(dialog).findByRole("option", { name: "Folder src" }));
    await within(dialog).findByRole("option", { name: "app.ts" });
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const srcReads = fileReads(calls).filter((u) => u.includes("path=src")).length;
    await user.click(plus());
    await user.click(await projectRow());
    dialog = await picker();
    await within(dialog).findByRole("option", { name: "README.md" });
    expect(within(dialog).queryByRole("option", { name: "app.ts" })).toBeNull();
    expect(fileReads(calls).filter((u) => u.includes("path=src"))).toHaveLength(srcReads);
  });

  it("a failed listing is drawn in place of the rows with a retry", async () => {
    let fail = true;
    chatApi({
      [`GET ${FILES}`]: (c) =>
        fail ? json(500, { error: { code: "internal", message: "boom" } }) : listing(c),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus());
    await user.click(await projectRow());
    const dialog = await picker();
    const retry = await within(dialog).findByRole("button", { name: en.common.retry });
    fail = false;
    await user.click(retry);
    expect(await within(dialog).findByRole("option", { name: "README.md" })).toBeTruthy();
  });

  it("a path leaving the project marks its chip (paths compared normalized); a new pick clears the marks", async () => {
    chatApi({
      [`POST ${BASE}/messages`]: refusal("device.path_outside_project", [{ path: "./README.md" }]),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await reference(user, ["README.md"]);
    await user.type(input(), "read it{Enter}");
    expect(await screen.findByText(missingText("README.md"))).toBeTruthy();
    // picked again: the marks go
    await user.click(plus());
    await user.click(await projectRow());
    const dialog = await picker();
    await within(dialog).findByRole("option", { name: "README.md" });
    await user.click(within(dialog).getByRole("button", { name: "Reference" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(missingText("README.md"))).toBeNull();
    expect(
      within(screen.getByRole("group", { name: en.chat.files })).getByText("README.md"),
    ).toBeTruthy();
  });

  it.each(["zh", "en"] as const)(
    "a conversation without a project says so in its own words (%s)",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      chatApi({
        [`POST ${BASE}/messages`]: refusal("conversation.project_file_unavailable", [
          { reason: "no_project" },
        ]),
      });
      await renderChatRoute({ locale });
      await screen.findByText("hi");
      const user = userEvent.setup();
      await user.click(plus(m));
      await user.click(await projectRow(m));
      const dialog = await screen.findByRole("dialog");
      await user.click(await within(dialog).findByRole("option", { name: "README.md" }));
      await user.click(within(dialog).getAllByRole("button").at(-1) as HTMLElement);
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.type(input(m), "read it{Enter}");
      const copy = m.errors.conversation.project_file_unavailable;
      expect(await screen.findByText(copy.no_project)).toBeTruthy();
      expect(screen.queryByText(copy.default)).toBeNull();
    },
  );

  it("Retry of a failed run sends the project files and resources again", async () => {
    const calls = chatApi(
      {
        [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(4, "look", { retryOf: 1 }) }),
      },
      { deviceId: "e1", project: CORE },
      [
        userMsg(1, "look", {
          content: [
            { type: "text", text: "look" },
            { type: "text", text: "the handbook body" },
            { type: "text", text: "Referenced project file: src/app.ts (...)" },
          ],
          attachments: [{ appId: "k1", appName: "Docs", uri: "docs://h", name: "Handbook" }],
          projectFiles: [{ path: "src/app.ts" }],
        }),
        runStarted(2),
        ev(3, "run_failed", { error: { code: "model.timeout", message: "x" } }),
      ],
    );
    await renderChatRoute();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    const post = calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    expect(bodyOf(post[0])).toMatchObject({
      text: "look",
      retryOf: 1,
      attachments: [{ connectorId: "k1", uri: "docs://h" }],
      projectFiles: [{ path: "src/app.ts" }],
    });
  });

  it("the pending bubble names each project file by its whole path with its type badge", async () => {
    chatApi({ [`POST ${BASE}/messages`]: () => new Promise<Response>(() => {}) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus());
    await user.click(await projectRow());
    const dialog = await picker();
    await user.click(await within(dialog).findByRole("option", { name: "Folder src" }));
    await user.click(await within(dialog).findByRole("option", { name: "app.ts" }));
    await user.click(within(dialog).getByRole("button", { name: "Reference" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.type(input(), "read it{Enter}");
    const bubble = await vi.waitFor(() => {
      const el = document.querySelector("[data-pending]");
      if (!el) throw new Error("no pending bubble");
      return el as HTMLElement;
    });
    const chip = within(bubble).getByText("src/app.ts").closest('[data-part="attachment"]');
    expect(chip?.querySelector(".cb-type-badge")?.textContent).toBe(typeBadge("src/app.ts", ""));
  });

  it("a device that cannot list closes the picker, says why and disables the row", async () => {
    chatApi({
      [`GET ${FILES}`]: () =>
        json(409, { error: { code: "device.list_unsupported", message: "cannot list" } }),
    });
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(plus(zh));
    await user.click(await projectRow(zh));
    expect(await screen.findByText(zh.errors.device.list_unsupported)).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(plus(zh));
    const row = await projectRow(zh);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain(zh.errors.device.list_unsupported);
  });
});

describe("a new conversation in a project", () => {
  const newRoutes = () => ({
    [`GET ${ORG}/attachments/limits`]: () => json(200, LIMITS),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/devices`]: () => json(200, DEVICES),
    [`GET ${ORG}/devices/e1/projects`]: () =>
      json(200, {
        projects: [{ ...CORE, createdAt: "2026-11-15T00:00:00.000Z" }],
        hidden: 0,
        mode: "auto",
        base: "/Users/o",
        supported: true,
      }),
    [`GET ${ORG}/conversation-permission-preview?deviceId=e1`]: () =>
      json(200, permissionPreview({ deviceId: "e1" })),
    [`GET ${ORG}/conversations/groups`]: () => json(200, { groups: [], next: null }),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${FILES}`]: listing,
  });

  it("the create body carries the project and the project files", async () => {
    resetNavigation("/");
    const calls = stubApi({
      ...newRoutes(),
      [`POST ${ORG}/conversations/first-message`]: () =>
        json(201, { ...CONV("c9"), event: userMsg(1, "go"), events: [userMsg(1, "go")] }),
    });
    await renderRouteWithCache("/", newRoutes());
    const user = userEvent.setup();
    // free mode: no project row
    await user.click(plus());
    await screen.findByRole("option", { name: en.chat.composerMenu.upload });
    expect(
      screen.queryByRole("option", { name: new RegExp(`^${en.chat.composerMenu.projectFiles}`) }),
    ).toBeNull();
    await user.click(plus());
    await user.click(screen.getByRole("button", { name: new RegExp(`^${en.chat.pickDevice}: `) }));
    await user.click(await screen.findByRole("menuitemradio", { name: "core" }));
    await user.click(plus());
    await user.click(await projectRow());
    const dialog = await picker();
    await user.click(await within(dialog).findByRole("option", { name: "package.json" }));
    await user.click(within(dialog).getByRole("button", { name: "Reference" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      deviceId: "e1",
      project: "core",
      message: { text: "go", projectFiles: [{ path: "package.json" }] },
    });
  });
});

describe("a new conversation in a project: refusals and project changes", () => {
  const projects = (list: { name: string; path: string }[]) => () =>
    json(200, {
      projects: list.map((p) => ({ ...p, createdAt: "2026-11-15T00:00:00.000Z" })),
      hidden: 0,
      mode: "auto",
      base: "/Users/o",
      supported: true,
    });
  const routes = (extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) => ({
    [`GET ${ORG}/attachments/limits`]: () => json(200, LIMITS),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/devices`]: () => json(200, DEVICES),
    [`GET ${ORG}/devices/e1/projects`]: projects([CORE, { name: "web", path: "/Users/o/src/web" }]),
    [`GET ${ORG}/conversation-permission-preview?deviceId=e1`]: () =>
      json(200, permissionPreview({ deviceId: "e1" })),
    [`GET ${ORG}/conversations/groups`]: () => json(200, { groups: [], next: null }),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${FILES}`]: listing,
    ...extra,
  });
  const pickProject = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(plus());
    await user.click(screen.getByRole("button", { name: new RegExp(`^${en.chat.pickDevice}: `) }));
    await user.click(await screen.findByRole("menuitemradio", { name }));
  };

  it("a refused create marks the chip in the composer it comes back to", async () => {
    resetNavigation("/");
    const r = routes({
      [`POST ${ORG}/conversations/first-message`]: refusal(
        "conversation.project_file_unavailable",
        [{ path: "package.json" }],
      ),
    });
    stubApi(r);
    await renderRouteWithCache("/", r);
    const user = userEvent.setup();
    await pickProject(user, "core");
    await reference(user, ["package.json"]);
    await user.type(input(), "go{Enter}");
    expect(await screen.findByText(missingText("package.json"))).toBeTruthy();
    expect(input().value).toBe("go");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("switching the project drops the chips", async () => {
    resetNavigation("/");
    const r = routes();
    stubApi(r);
    await renderRouteWithCache("/", r);
    const user = userEvent.setup();
    await pickProject(user, "core");
    await reference(user, ["README.md"]);
    expect(
      within(screen.getByRole("group", { name: en.chat.files })).getByText("README.md"),
    ).toBeTruthy();
    await pickProject(user, "web");
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull());
  });
});

describe("the bubble", () => {
  it("shows a logged message's project files as chips, never their English blocks", async () => {
    const block = (path: string) => ({
      type: "text",
      text: `Referenced project file: ${path} (in the project root ${ROOT}; read it with Read when needed).`,
    });
    chatApi({}, { deviceId: "e1", project: CORE }, [
      userMsg(1, "look", {
        content: [{ type: "text", text: "look" }, block("src/app.ts")],
        projectFiles: [{ path: "src/app.ts" }],
      }),
    ]);
    await renderChatRoute();
    await screen.findByText("look");
    expect(screen.getByText("src/app.ts")).toBeTruthy();
    expect(screen.queryByText(/Referenced project file/)).toBeNull();
  });

  it("a project file chip opens and downloads nothing (it is not an upload)", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    chatApi({}, { deviceId: "e1", project: CORE }, [
      userMsg(1, "look", {
        content: [
          { type: "text", text: "look" },
          { type: "text", text: "Referenced project file: src/app.ts (...)" },
        ],
        projectFiles: [{ path: "src/app.ts" }],
      }),
    ]);
    await renderChatRoute();
    await screen.findByText("look");
    const chip = screen.getByText("src/app.ts").closest("button") as HTMLButtonElement;
    await userEvent.setup().click(chip);
    expect(open).not.toHaveBeenCalled();
  });
});
