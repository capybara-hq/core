import type { LocalizedName } from "@capybara-hq/plugin-sdk";

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
export async function orElse<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}
