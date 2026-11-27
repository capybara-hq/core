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
  FakeEventSource,
  LIMITS,
  MODELS,
  permissionPreview,
  renderChatRoute,
  userMsg,
} from "./support/conversation";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

/**
 * Project files (composer menus §5, plan Task 6): the + menu's 项目文件 opens the picker on the
 * conversation's device project; chosen files become chips, go out as `projectFiles` and need text
 * like `@` resources; the bubble shows a logged message's project files as chips, never their
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
/** The + button (named by the design: 添加附件 / Attach files). */
const plus = (m = en) =>
  screen.getByRole("button", { name: m === zh ? "添加附件" : "Attach files" });
const sendButton = (m = en) => screen.getByRole("button", { name: m.chat.send });
const projectRow = async (m = en) => {
  await screen.findByRole("listbox");
  return screen.findByRole("option", { name: new RegExp(`^${m.chat.composerMenu.projectFiles}`) });
};
/** The picker's dialog (named by the design's title). */
const picker = (title = "Reference project files") => screen.findByRole("dialog", { name: title });

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
    expect(within(strip).getByText("app.ts")).toBeTruthy();
    // a chip's × removes it
    await user.click(within(strip).getByRole("button", { name: /README\.md/ }));
    expect(within(strip).queryByText("README.md")).toBeNull();
    expect(within(strip).getByText("app.ts")).toBeTruthy();
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
        json(409, {
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
});
