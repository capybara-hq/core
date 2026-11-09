import type { DeviceView } from "./devices.service.js";

const PERSONAL = { zh: "个人设备", en: "Personal" } as const;

/**
 * A device's name for people outside the web (the IM `/device` list, the `Platform` tool): its
 * own name, else 「个人设备」 / "Personal" for the default, else for a default demoted by a provider
 * switch the default's name plus the provider's display name (its plugin id when it has none),
 * e.g. 「个人设备（Docker 沙箱）」 / "Personal (Docker sandbox)", with " 2", " 3", … after the
 * first of the same provider. The web builds the same label from its own messages.
 */
export function deviceLabel(
  v: Pick<DeviceView, "name" | "demotedFrom">,
  locale: "zh" | "en",
): string {
  if (v.name !== null) return v.name;
  const d = v.demotedFrom;
  if (d === null) return PERSONAL[locale];
  const provider = d.displayName?.[locale] ?? d.provider;
  const nth = d.ordinal > 1 ? ` ${d.ordinal}` : "";
  return locale === "zh"
    ? `${PERSONAL.zh}（${provider}）${nth}`
    : `${PERSONAL.en} (${provider})${nth}`;
}

/** The words the default device answers to in `/device <name>` besides its label. */
export const DEFAULT_DEVICE_ALIASES: readonly string[] = [
  PERSONAL.zh.toLowerCase(),
  PERSONAL.en.toLowerCase(),
];
