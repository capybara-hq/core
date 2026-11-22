import { describe, expect, it } from "vitest";
import {
  type Device,
  type DeviceList,
  type DeviceProviderOption,
  deviceChoiceShown,
  deviceState,
  providerLabel,
} from "../src/lib/devices";

const dev = (o: Partial<Device>): Device =>
  ({
    id: "d1",
    available: true,
    filesLost: false,
    online: null,
    instance: null,
    provider: "device-e2b",
    providerDisplayName: null,
    ...o,
  }) as Device;
const list = (o: Partial<DeviceList>): DeviceList =>
  ({
    items: [],
    providers: [],
    defaultId: null,
    lastUsedId: null,
    defaultProvider: null,
    ...o,
  }) as DeviceList;
const OPTION: DeviceProviderOption = {
  plugin: "device-e2b",
  displayName: null,
  description: null,
  dialIn: false,
  guide: null,
};

describe("devices model", () => {
  it("deviceState: a dial-in device is online/offline, others follow the instance", () => {
    expect(deviceState(dev({ online: true }))).toBe("online");
    expect(deviceState(dev({ online: false }))).toBe("offline");
    expect(deviceState(dev({ online: null, instance: null }))).toBe("notStarted");
    expect(
      deviceState(dev({ instance: { status: "running", lastUsedAt: "2026-01-01T00:00:00Z" } })),
    ).toBe("running");
    expect(deviceState(dev({ available: false, online: true }))).toBe("unavailable");
    expect(deviceState(dev({ filesLost: true, online: true }))).toBe("filesLost");
  });
  it("providerLabel uses the display name in the UI language, the plugin name without one", () => {
    const name = { zh: "E2B 云端", en: "E2B cloud" };
    expect(providerLabel({ provider: "device-e2b", providerDisplayName: name }, "zh")).toBe(
      "E2B 云端",
    );
    expect(providerLabel({ provider: "device-e2b", providerDisplayName: name }, "en")).toBe(
      "E2B cloud",
    );
    expect(providerLabel({ provider: "device-x", providerDisplayName: null }, "en")).toBe(
      "device-x",
    );
    expect(providerLabel({ provider: null, providerDisplayName: null }, "en")).toBe("");
  });
  it("deviceChoiceShown: providers or devices", () => {
    expect(deviceChoiceShown(list({ providers: [], items: [] }))).toBe(false);
    expect(deviceChoiceShown(list({ providers: [OPTION], items: [] }))).toBe(true);
    expect(deviceChoiceShown(list({ items: [dev({})] }))).toBe(true);
  });
});
