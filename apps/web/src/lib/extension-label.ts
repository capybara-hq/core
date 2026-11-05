import type { LocalizedName } from "./catalog";

/** What a label needs from an extension: its id and the optional bilingual display name. */
export interface Labelled {
  name: string;
  displayName?: LocalizedName | null | undefined;
}

/**
 * The extension's name for people: the display name in the page locale, else the id.
 * The only place that turns an extension into a label (rule `web-ui-extension-label`).
 */
export function extensionLabel(x: Labelled, locale: "zh" | "en"): string {
  return x.displayName ? x.displayName[locale] : x.name;
}

/** `Provider display name / model`, e.g. "OpenAI 兼容 / deepseek/deepseek-flash". */
export function modelLabel(provider: Labelled, model: string, locale: "zh" | "en"): string {
  return `${extensionLabel(provider, locale)} / ${model}`;
}

/** The page locale as the two languages the UI has. */
export const labelLocale = (locale: string): "zh" | "en" => (locale === "zh" ? "zh" : "en");
