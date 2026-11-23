/** A connector template's description as the API returns it: the text for every language and the Chinese one. */
export interface TemplateDescription {
  /** The English text, or the one text a plain-string description has; null without one. */
  description: string | null;
  /** The Chinese text of a `{ zh, en }` description; null: `description` serves both languages. */
  descriptionZh: string | null;
}

/**
 * Splits a template file's `description` (a string, or `{ zh, en }`; read from stored JSON, so any
 * other shape counts as none) into the API's `description` / `descriptionZh` pair.
 */
export function templateDescription(v: unknown): TemplateDescription {
  if (typeof v === "string") return { description: v === "" ? null : v, descriptionZh: null };
  const d = v as { zh?: unknown; en?: unknown } | null | undefined;
  if (typeof d?.en === "string" && typeof d.zh === "string") {
    return { description: d.en, descriptionZh: d.zh };
  }
  return { description: null, descriptionZh: null };
}

/** {@link templateDescription} with "" rather than null without one (the wizard and the review). */
export function templateDescriptionText(v: unknown): {
  description: string;
  descriptionZh: string | null;
} {
  const d = templateDescription(v);
  return { description: d.description ?? "", descriptionZh: d.descriptionZh };
}
