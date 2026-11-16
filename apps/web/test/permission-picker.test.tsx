import { ComposerBox } from "@capybara-hq/design";
import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionChoice } from "../src/components/conversation/PermissionPicker";
import type { PermissionPreview } from "../src/lib/permissions";
import { json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  DEVICES,
  FakeEventSource,
  LIMITS,
  MODELS,
  noProjects,
  permissionAvailability,
  permissionPreview,
  permissionsView,
  snapshotDefaults,
} from "./support/conversation";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME, pageElement, renderPage, testQueryClient } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
beforeEach(() => {
  resetNavigation("/");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

const MEMBER = { ...ME, memberships: ME.memberships.map((m) => ({ ...m, role: "member" })) };
const previewUrl = (deviceId: string, project?: string) =>
  `GET /api/v1/orgs/o1/conversation-permission-preview?deviceId=${deviceId}${
    project === undefined ? "" : `&project=${project}`
  }`;

type Where = { deviceId?: string; project?: string; deviceLabel?: string };

/** The real composer box with the permission choice in its slot, as a page passes it. */
function Harness({ deviceId, project, deviceLabel = "Laptop" }: Where) {
  const choice = usePermissionChoice({
    orgId: "o1",
    deviceId,
    project,
    deviceLabel,
    context: "new",
  });
  return (
    <>
      <ComposerBox
        value=""
        onChange={() => {}}
        placeholder="Message"
        onAttach={() => {}}
        pickers={{
          device: { label: "Device", value: deviceLabel, groups: [], onPick: () => {} },
          permission: choice.picker,
          model: { label: "Model", value: "gpt-6", groups: [], onPick: () => {} },
          effort: { label: "Effort", value: "High", groups: [], onPick: () => {} },
        }}
        send={{ mode: "send", onClick: () => {} }}
      />
      <output data-testid="selection">{JSON.stringify(choice.selection)}</output>
      {choice.dialog}
    </>
  );
}

function mount(
  where: Where,
  preview: Partial<PermissionPreview> | null = {},
  opts: { locale?: "zh" | "en"; me?: typeof ME } = {},
) {
  const calls = stubApi(
    where.deviceId === undefined || preview === null
      ? {}
      : {
          [previewUrl(where.deviceId, where.project)]: () =>
            json(
              200,
              permissionPreview({
                deviceId: where.deviceId as string,
                project: where.project ?? null,
                ...preview,
              }),
            ),
        },
  );
  const client = testQueryClient();
  const r = renderPage(<Harness {...where} />, { client, locale: opts.locale ?? "en", ...opts });
  const rerender = (next: Where) =>
    r.rerender(
      pageElement(<Harness {...next} />, { client, locale: opts.locale ?? "en", ...opts }),
    );
  return { calls, client, rerender };
}

const permissionButton = () => screen.getByRole("button", { name: /^Permissions: / });
const selection = () => JSON.parse(screen.getByTestId("selection").textContent ?? "{}");
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(permissionButton());
  return screen.getByRole("menu");
}
const rows = (menu: HTMLElement) => within(menu).getAllByRole("menuitemradio");
const full = (menu: HTMLElement) =>
  within(menu).getByRole("menuitemradio", { name: /^Full access/ });

describe("the permission choice in the composer", () => {
  it("Request / Approve / Full use one neutral treatment and device-permission-model-effort order", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" });
    const pickers = document.querySelector('[data-part="composer-pickers"]') as HTMLElement;
    expect(
      within(pickers)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Device: Laptop", "Permissions: Approve for me", "Model: gpt-6", "Effort: High"]);
    // the default is Approve for me
    expect(selection()).toEqual({ profile: "approve-for-me" });
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(full(menu).getAttribute("aria-disabled")).toBeNull();
      await user.keyboard("{Escape}");
    });
    const menu = await openMenu(user);
    const items = rows(menu);
    expect(items.map((i) => i.querySelector('[data-part="menu-desc"]') !== null)).toEqual([
      true,
      true,
      true,
    ]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(
      items.map((i) => [
        within(i).getByText(/^(Request approval|Approve for me|Full access)$/).textContent,
        i.querySelector("[data-icon]")?.getAttribute("data-icon"),
      ]),
    ).toEqual([
      ["Request approval", "hand"],
      ["Approve for me", "shield-check"],
      ["Full access", "lock-open"],
    ]);
    // one look for all three: no tone, badge, style or accent on any row (Full included)
    const look = (i: HTMLElement) =>
      JSON.stringify({
        cls: i.className,
        tone: i.getAttribute("data-tone"),
        style: i.getAttribute("style"),
        badge: i.querySelector(".cb-badge, [data-tone]") !== null,
        icon: i.querySelector(".cb-icon")?.getAttribute("class"),
        desc: i.querySelector('[data-part="menu-desc"]')?.className,
      });
    expect(new Set(items.map(look)).size).toBe(1);
    expect(menu.querySelectorAll('[data-icon="check"]')).toHaveLength(1);
    expect(items[1]?.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(
      items.map(
        (i) => document.getElementById(i.getAttribute("aria-describedby") ?? "")?.textContent,
      ),
    ).toEqual([
      "Works directly in the project and asks you before going beyond it.",
      "Works directly in the project and hands extra access to automatic review.",
      "Uses the full access already authorized on this device, without asking each time.",
    ]);
  });

  it("keyboard picks a row; its checkmark and the button follow", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" });
    permissionButton().focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toContain("Request approval");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(permissionButton().getAttribute("aria-label")).toBe("Permissions: Request approval");
    expect(selection()).toEqual({ profile: "request-approval" });
    const menu = await openMenu(user);
    expect(rows(menu)[0]?.getAttribute("aria-checked")).toBe("true");
    expect(menu.querySelectorAll('[data-icon="check"]')).toHaveLength(1);
  });

  it("speaks Chinese with the approved copy", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" }, {}, { locale: "zh" });
    await user.click(screen.getByRole("button", { name: /^权限: / }));
    const menu = screen.getByRole("menu");
    expect(
      rows(menu).map((i) => [
        i.querySelector(".cb-cmenu-text")?.textContent,
        i.querySelector('[data-part="menu-desc"]')?.textContent,
      ]),
    ).toEqual([
      ["请求批准", "在项目内直接工作，超出范围时询问你。"],
      ["帮我批准", "在项目内直接工作，额外授权交给自动审查。"],
      ["完全访问", "使用此设备已授权的完整访问范围，不再逐次确认。"],
    ]);
    expect(menu.textContent).toContain("审查模型不可用或无法确定时，仍会询问你。");
    expect(menu.textContent).not.toMatch(/agent/i);
  });
});

describe("unavailable choices and their reasons", () => {
  it("no device: Request and Approve stay available, Full needs a device, nothing is read", async () => {
    const user = userEvent.setup();
    const { calls } = mount({});
    const menu = await openMenu(user);
    const [request, approve, f] = rows(menu);
    expect(request?.getAttribute("aria-disabled")).toBeNull();
    expect(approve?.getAttribute("aria-disabled")).toBeNull();
    expect(f?.getAttribute("aria-disabled")).toBe("true");
    expect(within(f as HTMLElement).getByText("Choose a device first")).toBeTruthy();
    expect(
      within(menu).getByRole("menuitemradio", { name: "Full access Choose a device first" }),
    ).toBe(f);
    await user.click(f as HTMLElement);
    expect(selection()).toEqual({ profile: "approve-for-me" });
    expect(calls).toEqual([]);
  });

  it.each([
    [
      "the owner's ceiling forbids Full",
      { fullAccessCeiling: false, availability: permissionAvailability("supported") },
      "Not allowed on this device",
    ],
    [
      "the runtime cannot run Full",
      {
        availability: {
          state: "supported" as const,
          report: {
            ...(permissionAvailability("supported") as { report: object }).report,
            fullAccess: false,
          },
        },
      },
      "Not supported on this device",
    ],
    [
      "the provider is unsupported",
      { availability: permissionAvailability("unsupported") },
      "Not supported on this device",
    ],
  ] as [string, Partial<PermissionPreview>, string][])(
    "%s: Full is disabled with its reason",
    async (_name, preview, reason) => {
      const user = userEvent.setup();
      mount({ deviceId: "d1" }, preview);
      await waitFor(async () => {
        const menu = await openMenu(user);
        expect(within(full(menu)).queryByText(reason)).not.toBeNull();
        await user.keyboard("{Escape}");
      });
      const menu = await openMenu(user);
      expect(full(menu).getAttribute("aria-disabled")).toBe("true");
      // a raw provider reason never shows in the menu
      expect(menu.textContent).not.toContain("Provider does not support");
    },
  );

  it("a supported report without restricted execution disables Request and Approve, never falling back to Full", async () => {
    const user = userEvent.setup();
    const supported = permissionAvailability("supported") as { report: object };
    mount(
      { deviceId: "d1" },
      {
        availability: {
          state: "supported",
          report: { ...supported.report, restricted: null },
        } as never,
      },
    );
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(rows(menu)[0]?.getAttribute("aria-disabled")).toBe("true");
      await user.keyboard("{Escape}");
    });
    const menu = await openMenu(user);
    const [request, approve, f] = rows(menu);
    for (const r of [request, approve])
      expect(within(r as HTMLElement).getByText("Can't keep work inside the project")).toBeTruthy();
    expect(f?.getAttribute("aria-disabled")).toBeNull();
    // the default stays the (unavailable) Approve for me; nothing chose Full
    expect(selection()).toEqual({ profile: "approve-for-me" });
  });

  it("an unprobed device stays selectable and says it is checked when it starts, without any provisioning", async () => {
    const user = userEvent.setup();
    const { calls } = mount({ deviceId: "d1" });
    await waitFor(() => expect(calls).toHaveLength(1));
    const menu = await openMenu(user);
    expect(rows(menu).every((r) => r.getAttribute("aria-disabled") === null)).toBe(true);
    expect(menu.textContent).toContain("Checked when this device starts.");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "/api/v1/orgs/o1/conversation-permission-preview?deviceId=d1"],
    ]);
  });

  it("Full waits for the device check before it can be chosen", async () => {
    const user = userEvent.setup();
    stubApi({ [previewUrl("d1")]: () => new Promise<Response>(() => {}) });
    renderPage(<Harness deviceId="d1" />, { client: testQueryClient() });
    const menu = await openMenu(user);
    expect(full(menu).getAttribute("aria-disabled")).toBe("true");
    expect(within(full(menu)).getByText("Checking this device…")).toBeTruthy();
  });
});

describe("Full access consent", () => {
  async function chooseFull(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(full(menu).getAttribute("aria-disabled")).toBeNull();
      await user.click(full(menu));
    });
    return screen.getByRole("dialog");
  }

  it("asks about the displayed device and project; cancel changes nothing", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1", project: "core", deviceLabel: "MacBook-Pro.local" });
    const dialog = await chooseFull(user);
    expect(within(dialog).getByText("Use Full access on MacBook-Pro.local?")).toBeTruthy();
    expect(dialog.textContent).toContain("not only the project core");
    expect(dialog.textContent).toContain("not root access");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(selection()).toEqual({ profile: "approve-for-me" });
    expect(permissionButton().getAttribute("aria-label")).toBe("Permissions: Approve for me");
  });

  it("confirming records the displayed scope revision with Full", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" }, { scopeRevision: "scope-7" });
    const dialog = await chooseFull(user);
    await user.click(within(dialog).getByRole("button", { name: "Use Full access" }));
    expect(selection()).toEqual({ profile: "full-access", consentScopeRevision: "scope-7" });
    expect(permissionButton().getAttribute("aria-label")).toBe("Permissions: Full access");
    // Full is drawn as any other selection: the checkmark only
    const menu = await openMenu(user);
    expect(full(menu).getAttribute("aria-checked")).toBe("true");
    expect(full(menu).getAttribute("data-tone")).toBeNull();
  });

  it("another device clears Full to Approve; a harmless rename keeps it; a non-Full choice survives", async () => {
    const user = userEvent.setup();
    const { rerender } = mount({ deviceId: "d1" });
    stubApi({
      [previewUrl("d1")]: () => json(200, permissionPreview({ deviceId: "d1" })),
      [previewUrl("d2")]: () => json(200, permissionPreview({ deviceId: "d2" })),
      [previewUrl("d1", "core")]: () =>
        json(200, permissionPreview({ deviceId: "d1", project: "core", scopeRevision: "scope-2" })),
    });
    const dialog = await chooseFull(user);
    await user.click(within(dialog).getByRole("button", { name: "Use Full access" }));
    expect(selection().profile).toBe("full-access");
    // the same identity and scope under another name: consent stays
    rerender({ deviceId: "d1", deviceLabel: "Renamed laptop" });
    expect(selection()).toEqual({ profile: "full-access", consentScopeRevision: "scope-1" });
    // another device: back to Approve for me, even after returning to the first one
    rerender({ deviceId: "d2" });
    await waitFor(() => expect(selection()).toEqual({ profile: "approve-for-me" }));
    rerender({ deviceId: "d1" });
    expect(selection()).toEqual({ profile: "approve-for-me" });
    // a different scope revision on the same device clears it too
    const again = await chooseFull(user);
    await user.click(within(again).getByRole("button", { name: "Use Full access" }));
    rerender({ deviceId: "d1", project: "core" });
    await waitFor(() => expect(selection()).toEqual({ profile: "approve-for-me" }));
    // a non-Full choice stays chosen across devices
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Request approval" }));
    rerender({ deviceId: "d2" });
    expect(selection()).toEqual({ profile: "request-approval" });
  });
});

describe("the review model note and its settings link", () => {
  it("an org admin gets the model purposes link", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" });
    const menu = await openMenu(user);
    expect(menu.textContent).toContain(
      "If a review model is unavailable or uncertain, you will be asked.",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Set up the review model" }));
    expect(router.push).toHaveBeenCalledWith("/settings/models?tab=purposes");
  });

  it("a member reads the note without a settings link", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" }, {}, { me: MEMBER });
    const menu = await openMenu(user);
    expect(menu.textContent).toContain(
      "If a review model is unavailable or uncertain, you will be asked.",
    );
    expect(within(menu).queryByRole("menuitem")).toBeNull();
  });
});

describe("phones: the options sheet", () => {
  it("lists the three choices with descriptions, disabled reasons and one checkmark", async () => {
    const user = userEvent.setup();
    mount({}, null, { locale: "zh" });
    await user.click(document.querySelector('[data-part="composer-options"]') as HTMLElement);
    const sheet = screen.getByRole("dialog");
    expect(
      [...sheet.querySelectorAll('[data-part="options-group"]')].map((g) =>
        g.getAttribute("data-group"),
      ),
    ).toEqual(["device", "permission", "model", "effort"]);
    const group = within(sheet).getByRole("radiogroup", { name: "权限" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual([
      "request-approval",
      "approve-for-me",
      "full-access",
    ]);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
    expect(radios[2]?.disabled).toBe(true);
    expect(within(group).getByRole("radio", { name: "完全访问 请先选择设备" })).toBe(radios[2]);
    expect(group.querySelectorAll('[data-icon="check"]')).toHaveLength(1);
    expect(new Set(radios.map((r) => r.closest("label")?.className)).size).toBe(1);
    await user.click(radios[0] as HTMLInputElement);
    expect(selection()).toEqual({ profile: "request-approval" });
    expect(screen.getByRole("dialog")).toBe(sheet);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});

const homeRoutes = () => ({
  "GET /api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [] }),
  "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
  "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
  "GET /api/v1/orgs/o1/attachments/limits": () => json(200, LIMITS),
  "GET /api/v1/orgs/o1/devices": () => json(200, DEVICES),
  ...noProjects(),
});

const chatRoutes = (id = "c1", row: Record<string, unknown> = {}, view = permissionsView()) => ({
  ...snapshotDefaults(id),
  [`GET /api/v1/orgs/o1/conversations/${id}`]: () => json(200, CONV(id, row)),
  [`GET /api/v1/orgs/o1/conversations/${id}/events`]: () => json(200, { events: [] }),
  [`GET /api/v1/orgs/o1/conversations/${id}/permissions`]: () => json(200, view),
});

/** The desktop picker of the page's composer (the phone button holds the same props). */
const composerPermission = () =>
  document.querySelector<HTMLElement>(
    '[data-part="composer-pickers"] [data-locked="true"][title], [data-part="composer-pickers"] .cb-picker[data-locked="true"]',
  );

describe("where the choice shows today (read-only until the send and live changes land)", () => {
  it("a new conversation shows the default Approve for me, read-only, on desktop and phone", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/", homeRoutes(), { locale: "en" });
    const pickers = document.querySelector('[data-part="composer-pickers"]') as HTMLElement;
    expect(within(pickers).getByText("Approve for me").getAttribute("data-locked")).toBe("true");
    expect(within(pickers).queryByRole("button", { name: /^Permissions/ })).toBeNull();
    const options = document.querySelector('[data-part="composer-options"]') as HTMLElement;
    expect(options.getAttribute("aria-label")).toContain("Approve for me");
    expect(browser).toEqual([]);
  });

  it("the owner sees the conversation's recorded profile from the hydrated read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(
      "/chat/c1",
      chatRoutes("c1", {}, permissionsView({ profile: "request-approval", revision: 3 })),
      { locale: "en" },
    );
    await screen.findAllByText("Request approval");
    const locked = composerPermission();
    expect(locked?.textContent).toBe("Request approval");
    expect(locked?.getAttribute("title")).toBe(
      "Works directly in the project and asks you before going beyond it.",
    );
    expect(browser).toEqual([]);
  });

  it("a sub-agent conversation shows the inherited profile read-only", async () => {
    await renderRouteWithCache(
      "/chat/c2",
      chatRoutes(
        "c2",
        { parentConversationId: "c1" },
        permissionsView({ profile: "full-access", rootConversationId: "c1" }),
      ),
      { locale: "zh" },
    );
    await screen.findAllByText("完全访问");
    expect(composerPermission()?.getAttribute("title")).toBe("跟随主对话的权限");
  });

  it("a scheduled task's conversation says it keeps its own unattended approvals", async () => {
    await renderRouteWithCache(
      "/chat/c1",
      {
        ...chatRoutes("c1", { scheduledTaskId: "t1" }),
        "GET /api/v1/orgs/o1/schedules/t1": () =>
          json(404, { error: { code: "schedule.not_found", message: "Scheduled task not found" } }),
      },
      { locale: "en" },
    );
    await screen.findAllByText("Approve for me");
    expect(composerPermission()?.getAttribute("title")).toBe(
      "Scheduled tasks keep their own unattended approval rules",
    );
  });

  it("a shared viewer sees no permission choice and never reads the owner's", async () => {
    const { calls } = await renderRouteWithCache(
      "/chat/c1",
      chatRoutes("c1", { accountId: "someone-else" }),
      { locale: "en" },
    );
    await act(async () => {});
    expect(screen.queryByText("Approve for me")).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/permissions"))).toEqual([]);
    expect(
      (document.querySelector('[data-part="composer-options"]') as HTMLElement).getAttribute(
        "aria-label",
      ),
    ).not.toContain("Approve");
  });
});
