import { apiFetch } from "./api";

/** Localized plugin text: English, optional Chinese (falls back to English). */
export interface GuideText {
  en: string;
  zh?: string;
}

/** The text of the UI language. */
export const guideText = (t: GuideText, locale: "zh" | "en"): string =>
  locale === "zh" ? (t.zh ?? t.en) : t.en;

/** Where a plugin's setup guide is (the org's catalog route). */
export interface SetupGuideRef {
  itemId: string;
  guideId: string;
}

/**
 * A plugin's setup guide rendered by the kernel for the org (spec
 * `2026-11-08-plugin-setup-guides-design.md` §4): steps, template files with the place's variables
 * filled in, the modes and the template hash an ack records.
 */
export interface RenderedSetupGuide {
  itemId: string;
  plugin: string;
  version: string;
  id: string;
  place: "channel-connection";
  title: GuideText;
  /** The modes the guide's steps and files use; empty = no mode switch. */
  modes: string[];
  mode: string | null;
  steps: GuideText[];
  files: {
    title: GuideText;
    language: "yaml" | "json" | "text";
    fileName: string;
    content: string;
  }[];
  /** Known variables without a value here (left as `{{name}}` in the text). */
  unresolved: string[];
  hash: string;
}

/** What to render the guide for: a connection, a mode, or the name typed so far. */
export interface SetupGuideQuery {
  connectionId?: string;
  mode?: string;
  name?: string;
}

export const getSetupGuide = (orgId: string, ref: SetupGuideRef, q: SetupGuideQuery = {}) => {
  const params = new URLSearchParams();
  if (q.mode) params.set("mode", q.mode);
  if (q.connectionId) params.set("connectionId", q.connectionId);
  if (q.name) params.set("name", q.name);
  const query = params.toString();
  return apiFetch<{ guide: RenderedSetupGuide }>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/catalog/${encodeURIComponent(ref.itemId)}/guides/${encodeURIComponent(ref.guideId)}${query ? `?${query}` : ""}`,
  );
};
