import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ChromeCapabilityV1,
  type DeviceCapabilityV1,
  type DeviceCeilingRequest,
  MENU_ITEM_ID,
  type MenuCapabilityV1,
  MOBILE_SHELL_LIMITS,
  NAV_SECTION_ORDER,
  type NavAccountV1,
  type NavActionV1,
  type NavCapabilityV1,
  type NavSectionId,
  type NavStateV1,
  type NotifyCapabilityV1,
  type OpenExternalCapabilityV1,
  type ProfilesCapabilityV1,
  SHELL_CAPABILITIES,
  SHELL_CAPABILITY_KEYS,
  type ShellCallError,
  type ShellChromeTokens,
  type SignInCapabilityV1,
  type ThisMachineStatus,
} from "../src/index.js";

describe("desktop shell capability types", () => {
  it("names the capability keys as name@major", () => {
    expect(SHELL_CAPABILITY_KEYS).toEqual({
      chrome: "chrome@1",
      device: "device@1",
      notify: "notify@1",
      openExternal: "openExternal@1",
      signIn: "signIn@1",
      haptics: "haptics@1",
      share: "share@1",
      menu: "menu@1",
      nav: "nav@1",
      profiles: "profiles@1",
      push: "push@1",
    });
  });

  it("registers every key in SHELL_CAPABILITIES", () => {
    const registered = SHELL_CAPABILITIES.map((c) => c.key);
    for (const key of Object.values(SHELL_CAPABILITY_KEYS)) {
      expect(registered).toContain(key);
    }
  });

  it("types the device calls", () => {
    expectTypeOf<ReturnType<DeviceCapabilityV1["connect"]>>().toEqualTypeOf<
      Promise<"connected" | "cancelled">
    >();
    expectTypeOf<ReturnType<DeviceCapabilityV1["status"]>>().toEqualTypeOf<
      Promise<ThisMachineStatus>
    >();
    expectTypeOf<ReturnType<NotifyCapabilityV1["notify"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<OpenExternalCapabilityV1["open"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<SignInCapabilityV1["start"]>>().toEqualTypeOf<
      Promise<"signedIn" | "cancelled">
    >();
    expectTypeOf<ShellCallError>().toEqualTypeOf<
      "busy" | "no_activation" | "cancelled" | "failed"
    >();
  });

  it("takes a ceiling request as only the owner ceiling fields to change", () => {
    expectTypeOf<
      Parameters<DeviceCapabilityV1["requestCeiling"]>[0]
    >().toEqualTypeOf<DeviceCeilingRequest>();
    expectTypeOf<DeviceCeilingRequest>().toEqualTypeOf<{
      outsideSandbox?: boolean;
      network?: "open" | "allowlist";
      projectReach?: "workspace" | "os-user";
    }>();
    // a single field is a whole request: the others are never sent, so never touched
    expectTypeOf<{ network: "open" }>().toMatchTypeOf<DeviceCeilingRequest>();
    expectTypeOf<ReturnType<DeviceCapabilityV1["requestCeiling"]>>().toEqualTypeOf<
      Promise<"applied" | "cancelled">
    >();
  });

  it("names the mobile app spec as the owner of the new mobile capabilities", () => {
    for (const key of ["haptics@1", "share@1", "menu@1"]) {
      const entry = SHELL_CAPABILITIES.find((c) => c.key === key);
      expect(entry?.owner).toContain("mobile app spec");
    }
  });

  it("types the mobile calls", () => {
    expectTypeOf<ReturnType<MenuCapabilityV1["show"]>>().toEqualTypeOf<Promise<string | null>>();
    expectTypeOf<ChromeCapabilityV1["ready"]>().toEqualTypeOf<(() => Promise<void>) | undefined>();
  });

  it("pins the mobile limits and the menu item id", () => {
    expect(MOBILE_SHELL_LIMITS).toEqual({
      menuItems: 12,
      menuLabel: 64,
      menuTitle: 128,
      shareTitle: 256,
      shareText: 4000,
      url: 2048,
      // nav@1: a section or menu label 1..32, a badge count an integer 0..9999 (plan Decision 2)
      navLabel: 32,
      navCount: 9999,
      // nav@1 minor version (interaction model §10.3): the account's name 1..64 characters
      navAccountName: 64,
    });
    expect(MENU_ITEM_ID.test("a.b-c_1")).toBe(true);
    expect(MENU_ITEM_ID.test("")).toBe(false);
  });

  it("takes the scheme and background, and optionally the color tokens and singleScheme", () => {
    expectTypeOf<Parameters<ChromeCapabilityV1["setAppearance"]>[0]>().toEqualTypeOf<{
      scheme: "light" | "dark";
      background: string;
      tokens?: ShellChromeTokens;
      singleScheme?: boolean;
    }>();
    expectTypeOf<keyof ShellChromeTokens>().toEqualTypeOf<
      "bg" | "panel" | "ink" | "muted" | "line" | "accent" | "onAccent"
    >();
    // an older web sends only the scheme and background
    expectTypeOf<{ scheme: "dark"; background: string }>().toMatchTypeOf<
      Parameters<ChromeCapabilityV1["setAppearance"]>[0]
    >();
  });

  it("types the nav strip and the profile switcher", () => {
    expectTypeOf<NavSectionId>().toEqualTypeOf<
      "chats" | "inbox" | "agents" | "schedules" | "search"
    >();
    expectTypeOf<keyof NavStateV1>().toEqualTypeOf<"items" | "current" | "action" | "account">();
    // the shape the shell and the web ship in lockstep (interaction model §10.3, D12, D16): no
    // menu button, the pill's action always sent, account and side
    expectTypeOf<NavStateV1["action"]>().toEqualTypeOf<NavActionV1>();
    expectTypeOf<NavActionV1["icon"]>().toEqualTypeOf<"plus" | "square-pen">();
    expectTypeOf<keyof NavAccountV1>().toEqualTypeOf<"name" | "avatarUrl" | "initial" | "badge">();
    expectTypeOf<NavCapabilityV1["side"]>().toEqualTypeOf<"left" | "right" | undefined>();
    expectTypeOf<keyof NavCapabilityV1>().toEqualTypeOf<
      "set" | "onSelect" | "onAction" | "onAccount" | "side"
    >();
    expectTypeOf<NavCapabilityV1["onAction"]>().toEqualTypeOf<
      (listener: () => void) => () => void
    >();
    expectTypeOf<NavCapabilityV1["onAccount"]>().toEqualTypeOf<
      (listener: () => void) => () => void
    >();
    expectTypeOf<ReturnType<ProfilesCapabilityV1["show"]>>().toEqualTypeOf<Promise<void>>();
    expect(NAV_SECTION_ORDER).toEqual(["chats", "inbox", "agents", "schedules", "search"]);
  });
});
