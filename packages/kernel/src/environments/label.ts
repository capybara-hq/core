import type { EnvironmentView } from "./environments.service.js";

const PERSONAL = { zh: "个人环境", en: "Personal" } as const;

/**
 * An environment's name for people outside the web (the IM `/env` list, the `Platform` tool): its
 * own name, else 「个人环境」 / "Personal" for the default, else for a default demoted by a provider
 * switch the default's name plus the provider's display name (its plugin id when it has none),
 * e.g. 「个人环境（Docker 沙箱）」 / "Personal (Docker sandbox)", with " 2", " 3", … after the
 * first of the same provider. The web builds the same label from its own messages.
 */
export function environmentLabel(
  v: Pick<EnvironmentView, "name" | "demotedFrom">,
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

/** The words the default environment answers to in `/env <name>` besides its label. */
export const DEFAULT_ENVIRONMENT_ALIASES: readonly string[] = [
  PERSONAL.zh.toLowerCase(),
  PERSONAL.en.toLowerCase(),
];
