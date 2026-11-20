import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ChromeCapabilityV1,
  type DeviceCapabilityV1,
  type DeviceCeilingRequest,
  MENU_ITEM_ID,
  type MenuCapabilityV1,
  MOBILE_SHELL_LIMITS,
  type NavTabId,
  type NotifyCapabilityV1,
  type OpenExternalCapabilityV1,
  SHELL_CAPABILITIES,
  SHELL_CAPABILITY_KEYS,
  type ShellCallError,
  type SignInCapabilityV1,
  type ThisMachineStatus,
} from "../src/index.js";

describe("desktop shell capability types", () => {
  it("names the capability keys as name@major", () => {
    expect(SHELL_CAPABILITY_KEYS).toEqual({
      device: "device@1",
      notify: "notify@1",
      openExternal: "openExternal@1",
      signIn: "signIn@1",
      chrome: "chrome@1",
      nav: "nav@1",
      haptics: "haptics@1",
      share: "share@1",
      menu: "menu@1",
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
    for (const key of ["nav@1", "haptics@1", "share@1", "menu@1"]) {
      const entry = SHELL_CAPABILITIES.find((c) => c.key === key);
      expect(entry?.owner).toContain("mobile app spec");
    }
  });

  it("types the mobile calls", () => {
    expectTypeOf<ReturnType<MenuCapabilityV1["show"]>>().toEqualTypeOf<Promise<string | null>>();
    expectTypeOf<NavTabId>().toEqualTypeOf<"chats" | "agents" | "inbox" | "me">();
    expectTypeOf<ChromeCapabilityV1["ready"]>().toEqualTypeOf<(() => Promise<void>) | undefined>();
  });

  it("pins the mobile limits and the menu item id", () => {
    expect(MOBILE_SHELL_LIMITS).toEqual({
      navLabel: 32,
      navCount: 9999,
      menuItems: 12,
      menuLabel: 64,
      menuTitle: 128,
      shareTitle: 256,
      shareText: 4000,
      url: 2048,
    });
    expect(MENU_ITEM_ID.test("a.b-c_1")).toBe(true);
    expect(MENU_ITEM_ID.test("")).toBe(false);
  });
});
