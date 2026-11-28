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
  consentReachOf,
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
        segments={[]}
        onSubmit={() => {}}
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
const full = (menu: HTMLElement) => within(menu).getByRole("menuitemradio", { name: /^Auto/ });

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
        within(i).getByText(/^(Request approval|Approve for me|Auto)$/).textContent,
        i.querySelector("[data-icon]")?.getAttribute("data-icon"),
      ]),
    ).toEqual([
      ["Request approval", "hand"],
      ["Approve for me", "shield-check"],
      ["Auto", "lock-open"],
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
      "Asks you before every approval.",
      "A review model decides for you and asks you when unsure.",
      "Doesn't ask; the agent acts freely. Approvals that need someone else, and secrets only you can enter, still come to you.",
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
      ["请求批准", "每个审批都先问你。"],
      ["帮我批准", "审查模型替你判断，拿不准时问你。"],
      ["自动模式", "不再询问，智能体可以自由操作；需要别人批准的、需要你输入密钥的仍会出现。"],
    ]);
    expect(menu.textContent).not.toMatch(/agent/i);
  });
});

describe("unavailable choices and their reasons", () => {
  it("no device: every profile is selectable; Auto asks the device-less question and sends no consent", async () => {
    const user = userEvent.setup();
    const { calls } = mount({});
    const menu = await openMenu(user);
    expect(rows(menu).map((r) => r.getAttribute("aria-disabled"))).toEqual([null, null, null]);
    await user.click(full(menu));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Use Auto?")).toBeTruthy();
    expect(dialog.textContent).toContain(
      "Platform and connector actions run without asking, and are recorded.",
    );
    expect(dialog.textContent).toContain(
      "Approvals that need someone else, and secrets only you can enter, still come to you.",
    );
    expect(dialog.textContent).not.toContain("Commands still run in the sandbox");
    await user.click(within(dialog).getByRole("button", { name: "Use Auto" }));
    expect(selection()).toEqual({ profile: "full-access" });
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
    "%s: Auto stays available (it never depends on a ceiling)",
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

  it("an unsupported provider keeps every profile selectable and says why in one notice line", async () => {
    const user = userEvent.setup();
    mount(
      { deviceId: "d1" },
      {
        availability: {
          state: "unsupported",
          reason: "Provider does not support permission-scoped operations",
          cause: { kind: "provider-outdated", plugin: "sandbox-docker", version: "0.4.1" },
        },
      },
    );
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(menu.textContent).toContain("needs an update");
      await user.keyboard("{Escape}");
    });
    const menu = await openMenu(user);
    expect(rows(menu).map((r) => r.getAttribute("aria-disabled"))).toEqual([null, null, null]);
    expect(menu.textContent).toContain(
      "This device's sandbox plugin (sandbox-docker 0.4.1) needs an update before device tools can run; a super admin updates it in Plugins.",
    );
    expect(menu.textContent).not.toContain("Provider does not support");
    expect(menu.textContent).not.toContain("Not supported on this device");
  });

  it("a runtime that cannot enforce its sandbox says so in the notice, never in a tag", async () => {
    const user = userEvent.setup();
    mount(
      { deviceId: "d1" },
      {
        availability: {
          state: "unsupported",
          reason: "raw runtime reason",
          cause: { kind: "runtime" },
        },
      },
    );
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(menu.textContent).toContain("This device's runtime can't enforce its sandbox");
      await user.keyboard("{Escape}");
    });
    const menu = await openMenu(user);
    expect(rows(menu).map((r) => r.getAttribute("aria-disabled"))).toEqual([null, null, null]);
    expect(menu.textContent).not.toContain("raw runtime reason");
  });

  it("a supported device shows no notice", async () => {
    const user = userEvent.setup();
    const { calls } = mount(
      { deviceId: "d1" },
      { availability: permissionAvailability("supported") },
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    const menu = await openMenu(user);
    expect(menu.textContent).not.toContain("needs an update");
    expect(menu.textContent).not.toContain("can't enforce its sandbox");
  });

  it("a boundary report without restricted execution keeps every profile selectable", async () => {
    const user = userEvent.setup();
    const supported = permissionAvailability("supported") as { report: object };
    const { calls } = mount(
      { deviceId: "d1" },
      {
        availability: {
          state: "supported",
          report: { ...supported.report, boundary: "operation", restricted: null },
        } as never,
      },
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(full(menu).getAttribute("aria-disabled")).toBeNull();
      await user.keyboard("{Escape}");
    });
    const menu = await openMenu(user);
    expect(rows(menu).map((r) => r.getAttribute("aria-disabled"))).toEqual([null, null, null]);
  });

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
    expect(rows(menu).map((r) => r.getAttribute("aria-disabled"))).toEqual([null, null, "true"]);
    expect(within(menu).getAllByText("Checking this device…")).toHaveLength(1);
    expect(within(full(menu)).getByText("Checking this device…")).toBeTruthy();
  });

  it("a preview without its consent reach is a failed check: Auto stays unavailable", async () => {
    const user = userEvent.setup();
    stubApi({
      [previewUrl("d1")]: () => {
        const { consentReach: _gone, ...bare } = permissionPreview({ deviceId: "d1" });
        return json(200, bare);
      },
    });
    renderPage(<Harness deviceId="d1" />, { client: testQueryClient() });
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(within(full(menu)).getByText("Couldn't check this device")).toBeTruthy();
      await user.keyboard("{Escape}");
    });
    const menu = await openMenu(user);
    expect(full(menu).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Auto consent", () => {
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
    expect(within(dialog).getByText("Use Auto on MacBook-Pro.local?")).toBeTruthy();
    expect(
      within(dialog)
        .getAllByText(/./)
        .map((el) => el.textContent),
    ).toContain(
      "Commands still run in the sandbox; the agent's requests to go beyond it (including running commands outside the sandbox) are approved automatically and recorded. Platform and connector actions also run without asking, and are recorded.",
    );
    expect(dialog.textContent).toContain(
      "Protected paths and platform and organization denials still apply. Credential reads outside the sandbox and sub-agents' requests to run outside it still go to the review model. Approvals that need someone else, and secrets only you can enter, still come to you.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(selection()).toEqual({ profile: "approve-for-me" });
    expect(permissionButton().getAttribute("aria-label")).toBe(
      "Permissions: Approve for me: Effort High",
    );
  });

  // the confirmation names exactly what the recorded consent covers: a stored support that allows
  // running outside while the runtime is not reported yet (a recreated instance, a provider
  // version change, a machine's new hello) still covers it, so the dialog says so
  it("names running outside the sandbox from the consent reach while the runtime is unprobed", async () => {
    const user = userEvent.setup();
    const covered = permissionPreview({ availability: permissionAvailability("unprobed") });
    mount(
      { deviceId: "d1", deviceLabel: "MacBook-Pro.local" },
      {
        availability: permissionAvailability("unprobed"),
        outsideSandboxCeiling: true,
        consentReach: { ...covered.consentReach, outsideSandbox: true },
      },
    );
    const dialog = await chooseFull(user);
    expect(dialog.textContent).toContain(
      "the agent's requests to go beyond it (including running commands outside the sandbox) are approved automatically",
    );
  });

  it("leaves running outside the sandbox out when the consent reach does not cover it, whatever the runtime reports", async () => {
    const user = userEvent.setup();
    const supported = permissionPreview({ availability: permissionAvailability("supported") });
    mount(
      { deviceId: "d1", deviceLabel: "MacBook-Pro.local" },
      {
        availability: permissionAvailability("supported"),
        outsideSandboxCeiling: true,
        consentReach: { ...supported.consentReach, outsideSandbox: false },
      },
    );
    const dialog = await chooseFull(user);
    expect(dialog.textContent).toContain(
      "Commands still run in the sandbox; the agent's requests to go beyond it are approved automatically",
    );
    expect(dialog.textContent).not.toContain("outside the sandbox)");
  });

  it.each([
    [
      "the ceiling is off",
      {
        availability: permissionAvailability("supported"),
        outsideSandboxCeiling: false,
        consentReach: consentReachOf(false),
      },
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
        consentReach: consentReachOf(false),
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
          name: /^自动模式/,
        });
        expect(f.getAttribute("aria-disabled")).toBeNull();
        await user.click(f);
      });
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("在 云设备 上使用自动模式？")).toBeTruthy();
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
    await user.click(within(dialog).getByRole("button", { name: "Use Auto" }));
    expect(selection()).toEqual({ profile: "full-access", consentScopeRevision: "scope-7" });
    expect(permissionButton().getAttribute("aria-label")).toBe("Permissions: Auto: Effort High");
    // Full is drawn as any other selection: the checkmark only
    const menu = await openMenu(user);
    expect(full(menu).getAttribute("aria-checked")).toBe("true");
    expect(full(menu).getAttribute("data-tone")).toBeNull();
  });

  it("asks only on the first selection: Full again on the same device and scope needs no dialog", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1" }, { scopeRevision: "scope-7" });
    const dialog = await chooseFull(user);
    await user.click(within(dialog).getByRole("button", { name: "Use Auto" }));
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
    // Approve for me -> Auto: the confirmation opens, nothing granted yet
    const dialog = await screen.findByRole("dialog");
    expect(selection()).toEqual({ profile: "approve-for-me" });
    await user.click(within(dialog).getByRole("button", { name: "Use Auto" }));
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
    await user.click(within(dialog).getByRole("button", { name: "Use Auto" }));
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
    await user.click(within(again).getByRole("button", { name: "Use Auto" }));
    rerender({ deviceId: "d1", project: "core" });
    await waitFor(() => expect(selection()).toEqual({ profile: "approve-for-me" }));
    // a non-Full choice stays chosen across devices
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Request approval" }));
    rerender({ deviceId: "d2" });
    expect(selection()).toEqual({ profile: "request-approval" });
  });
});

describe("Auto chosen without a device", () => {
  it("falls back to the default when a device is then chosen, and asks again for it", async () => {
    const user = userEvent.setup();
    const { rerender } = mount({});
    const menu = await openMenu(user);
    await user.click(full(menu));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use Auto" }));
    expect(selection()).toEqual({ profile: "full-access" });
    stubApi({ [previewUrl("d1")]: () => json(200, permissionPreview({ deviceId: "d1" })) });
    rerender({ deviceId: "d1" });
    await waitFor(() => expect(selection()).toEqual({ profile: "approve-for-me" }));
  });
});

describe("the notice on phones", () => {
  it("the options sheet shows the same cause line as the mode menu", async () => {
    const user = userEvent.setup();
    mount(
      { deviceId: "d1" },
      {
        availability: {
          state: "unsupported",
          reason: "raw",
          cause: { kind: "provider-outdated", plugin: "sandbox-docker", version: "0.4.1" },
        },
      },
    );
    await waitFor(() => expect(screen.getByTestId("selection")).toBeTruthy());
    await user.click(document.querySelector('[data-part="composer-options"]') as HTMLElement);
    const sheet = screen.getByRole("dialog");
    await waitFor(() =>
      expect(sheet.querySelector('[data-part="options-notice"]')?.textContent).toBe(
        "This device's sandbox plugin (sandbox-docker 0.4.1) needs an update before device tools can run; a super admin updates it in Plugins.",
      ),
    );
    const group = within(sheet).getByRole("radiogroup", { name: "Permissions" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).disabled),
    ).toEqual([false, false, false]);
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

describe("a recorded Auto is the current state, never a new consent (10C review Minor 1)", () => {
  it("shows Full checked but yields no selection; choosing Full again needs the dialog", async () => {
    const user = userEvent.setup();
    mount({ deviceId: "d1", initial: "full-access" });
    expect(permissionButton().getAttribute("aria-label")).toBe("Permissions: Auto: Effort High");
    // no consent was given here: nothing could send or PATCH Auto
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
    await user.click(within(dialog).getByRole("button", { name: "Use Auto" }));
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
    expect(radios.map((r) => r.disabled)).toEqual([false, false, false]);
    expect(within(group).getByRole("radio", { name: /^自动模式/ })).toBe(radios[2]);
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
  "GET /api/v1/orgs/o1/files/limits": () => json(200, LIMITS),
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
    // with the top strip the phone's mode button is the same one: the settings chip holds the
    // model and the effort only
    const options = document.querySelector('[data-part="composer-options"]') as HTMLElement;
    expect(options.getAttribute("aria-label")).not.toContain("Approve for me");
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
    await screen.findAllByText("自动模式");
    expect(composerPermission()?.getAttribute("title")).toBe("跟随主对话的权限");
  });

  it("an automation's conversation says it keeps its own unattended approvals", async () => {
    await renderRouteWithCache(
      "/chat/c1",
      {
        ...chatRoutes("c1", { automationId: "t1" }),
        "GET /api/v1/orgs/o1/automations/t1": () =>
          json(404, { error: { code: "automation.not_found", message: "Automation not found" } }),
      },
      { locale: "en" },
    );
    await screen.findAllByText("Approve for me");
    expect(composerPermission()?.getAttribute("title")).toBe(
      "Automations keep their own unattended approval rules",
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
