/**
 * The clock time of an event in a conversation ("14:05"): the stop and approval stamps. In a
 * component pass `useTimeZone()` (`@capybara-hq/design`) as `timeZone`, so a server-rendered stamp
 * hydrates in the server's zone before it switches to the browser's.
 */
export const shortTime = (iso: string, locale: string, timeZone?: string): string =>
  new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone !== undefined && { timeZone }),
  });

/**
 * The browser's IANA time zone, written by the browser after hydration so the next server render
 * writes local times in the viewer's zone (the server's own zone until then).
 */
export const TIME_ZONE_COOKIE = "cb-tz";

/** `value` when it names an IANA time zone this runtime knows, else undefined. */
export function parseTimeZone(value: string | undefined): string | undefined {
  if (value === undefined || value === "" || value.length > 64) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
