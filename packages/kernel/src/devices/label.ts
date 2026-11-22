import type { DeviceView } from "./devices.service.js";

const PERSONAL = { zh: "个人设备", en: "Personal" } as const;

/**
 * A device's name for people outside the web (the IM `/device` list, the `Platform` tool): its
 * own name, else the localized "Personal" (`PERSONAL`, for the default device). The web builds
 * the same label from its own messages.
 */
export function deviceLabel(v: Pick<DeviceView, "name">, locale: "zh" | "en"): string {
  return v.name ?? PERSONAL[locale];
}

/** The words the default device answers to in `/device <name>` besides its label. */
export const DEFAULT_DEVICE_ALIASES: readonly string[] = [
  PERSONAL.zh.toLowerCase(),
  PERSONAL.en.toLowerCase(),
];
