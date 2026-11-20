import { ComposerBox } from "@capybara-hq/design";
import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  modeMenuFromPickers,
  usePermissionChoice,
} from "../src/components/conversation/PermissionPicker";
import type { PermissionPreview, PermissionProfile } from "../src/lib/permissions";
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

type Where = {
  deviceId?: string;
  project?: string;
  deviceLabel?: string;
  initial?: PermissionProfile;
};

/** The real composer box with the permission choice in its slot, as a page passes it. */
function Harness({ deviceId, project, deviceLabel = "Laptop", initial }: Where) {
  const choice = usePermissionChoice({
    orgId: "o1",
    deviceId,
    project,
    deviceLabel,
    context: "new",
    ...(initial !== undefined ? { initial } : {}),
  });
  const effort = {
    label: "Effort",
    value: "High",
    groups: [{ items: [{ id: "high", label: "High", checked: true }] }],
    onPick: () => {},
  };
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
          effort,
        }}
        mode={modeMenuFromPickers(choice.picker, effort, "⇧Tab to switch")}
        send={{ mode: "send", onClick: () => {} }}
      />
      <output data-testid="selection">{JSON.stringify(choice.selection ?? null)}</output>
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
/** The profile rows (the effort segments are menu items radios too). */
const rows = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitemradio")
    .filter((el) => el.getAttribute("data-part") === "menu-item");
const full = (menu: HTMLElement) =>
  within(menu).getByRole("menuitemradio", { name: /^Full access/ });

describe("the permission choice in the composer", () => {
  it("Request / Approve / Full use one neutral treatment in the mode menu before send", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" });
    const pickers = document.querySelector('[data-part="composer-pickers"]') as HTMLElement;
    // the left keeps the device and a compact model · effort chip; the mode button holds the rest
    expect(
      within(pickers)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Device: Laptop", "Model: gpt-6 · High"]);
    const mode = document.querySelector('[data-part="composer-mode"]') as HTMLElement;
    expect(within(mode).getByRole("button").getAttribute("aria-label")).toBe(
      "Permissions: Approve for me: Effort High",
    );
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
      "Works freely inside the sandbox; asks you before going beyond it or running sensitive commands.",
      "Same sandbox; a review model decides requests to go beyond it and asks you when unsure.",
      "Same sandbox; approves whatever this device allows, without asking. Credential reads outside the sandbox and sub-agents' requests to run outside it still go to the review model.",
    ]);
    // the head hints the shortcut; no explanation closes the menu, not even for an unprobed device
    expect(menu.textContent).toContain("⇧Tab to switch");
    expect(menu.querySelectorAll('[data-part="menu-note"]')).toHaveLength(0);
    // the effort sits under the profiles
    expect(within(menu).getByRole("group", { name: "Effort" })).toBeTruthy();
  });

  it("keyboard picks a row; its checkmark and the button follow", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" });
    permissionButton().focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toContain("Request approval");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(permissionButton().getAttribute("aria-label")).toBe(
      "Permissions: Request approval: Effort High",
    );
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
      ["请求批准", "在沙箱内直接工作；超出沙箱或执行敏感命令前先问你。"],
      ["帮我批准", "同样的沙箱；超出范围的请求交给审查模型，拿不准时问你。"],
      [
        "完全访问",
        "同样的沙箱；在此设备允许的范围内自动批准，不再询问。在沙箱外读取凭据和子智能体在沙箱外运行的请求仍交给审查模型。",
      ],
    ]);
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
      "the outside-sandbox ceiling is off",
      { outsideSandboxCeiling: false, availability: permissionAvailability("supported") },
    ],
    [
      "the runtime cannot run outside the sandbox",
      {
        availability: {
          state: "supported" as const,
          report: {
            ...(permissionAvailability("supported") as { report: object }).report,
            outsideSandbox: false,
          },
        },
      },
    ],
  ] as [string, Partial<PermissionPreview>][])(
    "%s: Full access stays available (it never depends on a ceiling)",
    async (_name, preview) => {
      const user = userEvent.setup();
      const { calls } = mount({ deviceId: "d1" }, preview);
      await waitFor(() => expect(calls).toHaveLength(1));
      await waitFor(async () => {
        const menu = await openMenu(user);
        expect(full(menu).getAttribute("aria-disabled")).toBeNull();
        await user.keyboard("{Escape}");
      });
      const menu = await openMenu(user);
      expect(menu.textContent).not.toContain("Not allowed on this device");
    },
  );

  it("an unsupported provider disables every profile with the same reason, never its raw text", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" }, { availability: permissionAvailability("unsupported") });
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(full(menu).getAttribute("aria-disabled")).toBe("true");
      await user.keyboard("{Escape}");
    });
    const menu = await openMenu(user);
    for (const r of rows(menu)) {
      expect(r.getAttribute("aria-disabled")).toBe("true");
      expect(within(r).getByText("Not supported on this device")).toBeTruthy();
    }
    expect(menu.textContent).not.toContain("Provider does not support");
  });

  it.each([
    ["operation", true],
    ["instance", false],
  ] as const)(
    "a %s-boundary report without restricted execution: every profile disabled = %s",
    async (boundary, disabled) => {
      const user = userEvent.setup();
      const supported = permissionAvailability("supported") as { report: object };
      const { calls } = mount(
        { deviceId: "d1" },
        {
          availability: {
            state: "supported",
            report: { ...supported.report, boundary, restricted: null },
          } as never,
        },
      );
      await waitFor(() => expect(calls).toHaveLength(1));
      await waitFor(async () => {
        const menu = await openMenu(user);
        expect(full(menu).getAttribute("aria-disabled")).toBe(disabled ? "true" : null);
        await user.keyboard("{Escape}");
      });
      const menu = await openMenu(user);
      expect(rows(menu).map((r) => r.getAttribute("aria-disabled") === "true")).toEqual([
        disabled,
        disabled,
        disabled,
      ]);
      expect(menu.textContent).not.toContain("Can't keep work inside the project");
    },
  );

  it("an unprobed device stays selectable with no note, without any provisioning", async () => {
    const user = userEvent.setup();
    const { calls } = mount({ deviceId: "d1" });
    await waitFor(() => expect(calls).toHaveLength(1));
    const menu = await openMenu(user);
    expect(rows(menu).every((r) => r.getAttribute("aria-disabled") === null)).toBe(true);
    expect(menu.querySelectorAll('[data-part="menu-note"]')).toHaveLength(0);
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

  it("asks about the displayed device, naming running outside the sandbox when the device allows it; cancel changes nothing", async () => {
    const user = userEvent.setup();
    mount(
      { deviceId: "d1", project: "core", deviceLabel: "MacBook-Pro.local" },
      { availability: permissionAvailability("supported"), outsideSandboxCeiling: true },
    );
    const dialog = await chooseFull(user);
    expect(within(dialog).getByText("Use Full access on MacBook-Pro.local?")).toBeTruthy();
    expect(
      within(dialog)
        .getAllByText(/./)
        .map((el) => el.textContent),
    ).toContain(
      "Commands still run in the sandbox; the agent's requests to go beyond it (including running commands outside the sandbox) are approved automatically and recorded.",
    );
    expect(dialog.textContent).toContain(
      "Protected paths and platform and organization denials still apply. Credential reads outside the sandbox and sub-agents' requests to run outside it still go to the review model.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(selection()).toEqual({ profile: "approve-for-me" });
    expect(permissionButton().getAttribute("aria-label")).toBe(
      "Permissions: Approve for me: Effort High",
    );
  });

  it.each([
    [
      "the ceiling is off",
      { availability: permissionAvailability("supported"), outsideSandboxCeiling: false },
    ],
    [
      "the device is a cloud instance",
      {
        availability: {
          state: "supported" as const,
          report: {
            ...(permissionAvailability("supported") as { report: object }).report,
            boundary: "instance",
            restricted: null,
            outsideSandbox: false,
          },
        },
        outsideSandboxCeiling: true,
      },
    ],
  ] as [string, Partial<PermissionPreview>][])(
    "the shorter dialog leaves running outside the sandbox out when %s (zh)",
    async (_name, preview) => {
      const user = userEvent.setup();
      mount({ deviceId: "d1", deviceLabel: "云设备" }, preview as never, { locale: "zh" });
      await waitFor(async () => {
        await user.click(screen.getByRole("button", { name: /^权限: / }));
        const f = within(screen.getByRole("menu")).getByRole("menuitemradio", {
          name: /^完全访问/,
        });
        expect(f.getAttribute("aria-disabled")).toBeNull();
        await user.click(f);
      });
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("在 云设备 上使用完全访问？")).toBeTruthy();
      expect(dialog.textContent).toContain(
        "命令仍在沙箱中运行；智能体超出沙箱的请求会自动批准并记录。",
      );
      expect(dialog.textContent).not.toContain("沙箱外运行命令");
      expect(dialog.textContent).toContain("受保护的路径、平台和组织的禁止项仍然有效。");
      expect(dialog.textContent).not.toMatch(/agent|企业/i);
    },
  );

  it("confirming records the displayed scope revision with Full", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" }, { scopeRevision: "scope-7" });
    const dialog = await chooseFull(user);
    await user.click(within(dialog).getByRole("button", { name: "Use Full access" }));
    expect(selection()).toEqual({ profile: "full-access", consentScopeRevision: "scope-7" });
    expect(permissionButton().getAttribute("aria-label")).toBe(
      "Permissions: Full access: Effort High",
    );
    // Full is drawn as any other selection: the checkmark only
    const menu = await openMenu(user);
    expect(full(menu).getAttribute("aria-checked")).toBe("true");
    expect(full(menu).getAttribute("data-tone")).toBeNull();
  });

  it("asks only on the first selection: Full again on the same device and scope needs no dialog", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" }, { scopeRevision: "scope-7" });
    const dialog = await chooseFull(user);
    await user.click(within(dialog).getByRole("button", { name: "Use Full access" }));
    let menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Approve for me" }));
    expect(selection()).toEqual({ profile: "approve-for-me" });
    menu = await openMenu(user);
    await user.click(full(menu));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(selection()).toEqual({ profile: "full-access", consentScopeRevision: "scope-7" });
  });

  it("Shift+Tab in the composer cycles the profiles; reaching Full asks first", async () => {
    const user = userEvent.setup();
    const { calls } = mount({ deviceId: "d1" });
    await waitFor(() => expect(calls).toHaveLength(1));
    screen.getByRole("textbox").focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    // Approve for me -> Full access: the confirmation opens, nothing granted yet
    const dialog = await screen.findByRole("dialog");
    expect(selection()).toEqual({ profile: "approve-for-me" });
    await user.click(within(dialog).getByRole("button", { name: "Use Full access" }));
    expect(selection().profile).toBe("full-access");
    screen.getByRole("textbox").focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(selection()).toEqual({ profile: "request-approval" });
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(selection()).toEqual({ profile: "approve-for-me" });
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

describe("a starting choice that arrives after mount (review M2)", () => {
  it("takes over a recorded profile read later, and a changed one again", async () => {
    const { rerender } = mount({});
    expect(selection()).toEqual({ profile: "approve-for-me" });
    rerender({ initial: "request-approval" });
    await waitFor(() => expect(selection()).toEqual({ profile: "request-approval" }));
    expect(permissionButton().getAttribute("aria-label")).toBe(
      "Permissions: Request approval: Effort High",
    );
    // the same starting value again leaves the person's own pick alone
    const user = userEvent.setup();
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Approve for me" }));
    rerender({ initial: "request-approval" });
    expect(selection()).toEqual({ profile: "approve-for-me" });
  });
});

describe("a recorded Full access is the current state, never a new consent (10C review Minor 1)", () => {
  it("shows Full checked but yields no selection; choosing Full again needs the dialog", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1", initial: "full-access" });
    expect(permissionButton().getAttribute("aria-label")).toBe(
      "Permissions: Full access: Effort High",
    );
    // no consent was given here: nothing could send or PATCH Full access
    expect(screen.getByTestId("selection").textContent).toBe("null");
    let menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Approve for me" }));
    expect(selection()).toEqual({ profile: "approve-for-me" });
    await waitFor(async () => {
      menu = await openMenu(user);
      expect(full(menu).getAttribute("aria-disabled")).toBeNull();
      await user.click(full(menu));
    });
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Use Full access" }));
    expect(selection()).toEqual({ profile: "full-access", consentScopeRevision: "scope-1" });
  });
});

describe("the review model settings link", () => {
  it("an org admin gets the model purposes link", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" });
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Set up the review model" }));
    expect(router.push).toHaveBeenCalledWith("/settings/models?tab=purposes");
  });

  it("a member gets no settings link", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" }, {}, { me: MEMBER });
    const menu = await openMenu(user);
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

/** The locked mode button of the page's composer (the phone button holds the same props). */
const composerPermission = () =>
  document.querySelector<HTMLElement>('[data-part="composer-mode"] [data-locked="true"][title]');
/** The page composer's mode button. */
const modeButton = () =>
  within(document.querySelector('[data-part="composer-mode"]') as HTMLElement).getByRole("button");

describe("where the choice shows (editable in a new conversation and an owner's interactive root)", () => {
  it("a new conversation offers the choice, Approve for me by default, on desktop and phone", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/", homeRoutes(), { locale: "en" });
    expect(modeButton().getAttribute("aria-label")).toMatch(/^Permissions: Approve for me/);
    expect(composerPermission()).toBeNull();
    const options = document.querySelector('[data-part="composer-options"]') as HTMLElement;
    expect(options.getAttribute("aria-label")).toContain("Approve for me");
    // the selected device's preview was prefetched: no browser read
    expect(browser).toEqual([]);
  });

  it("the owner of an interactive root edits the profile from the hydrated read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(
      "/chat/c1",
      chatRoutes("c1", {}, permissionsView({ profile: "request-approval", revision: 3 })),
      { locale: "en" },
    );
    expect(modeButton().getAttribute("aria-label")).toMatch(/^Permissions: Request approval/);
    expect(composerPermission()).toBeNull();
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
