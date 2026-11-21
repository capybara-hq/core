import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { readSkillPackage } from "../../skills/package.js";

/** Longest name quoted in a card summary (a name is set by people, and by agents through tools). */
const NAME_MAX = 80;

/** A name as a card summary quotes it: clipped to {@link NAME_MAX}. */
export const named = (s: string): string => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX)}…` : s);

/** A display name in both languages, clipped; `fallback` (the plain name) for a missing one. */
export const localized = (
  n: LocalizedName | null | undefined,
  fallback: string,
): { zh: string; en: string } => ({
  zh: named(n?.zh ?? fallback),
  en: named(n?.en ?? fallback),
});

/** The value of `read`, or `fallback` when the read throws (a summary never fails on a name). */
/**
 * The skill name a skill package's SKILL.md declares, for a card summary (the package is checked
 * as the write will check it); null when the bytes are absent or not a valid package.
 */
export async function skillPackageName(bytes: Uint8Array | undefined): Promise<string | null> {
  if (bytes === undefined) return null;
  return orElse(async () => (await readSkillPackage(bytes)).name, null);
}

export async function orElse<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}
