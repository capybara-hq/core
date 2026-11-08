import { apiFetch } from "./api";

/**
 * A person's preferences (`GET` / `PUT /api/v1/me/preferences`): `timeZone` null follows the
 * browser's time zone, which every message sends; a set zone overrides it for the agent's dates
 * (run context spec §3.4). `theme` null follows the org's theme (themes spec §7).
 */
export interface Preferences {
  timeZone: string | null;
  theme: string | null;
}

export const getPreferences = () => apiFetch<Preferences>("/api/v1/me/preferences");

/** A partial update: only the fields given change; the response has every field. */
export const putPreferences = (prefs: Partial<Preferences>) =>
  apiFetch<Preferences>("/api/v1/me/preferences", {
    method: "PUT",
    body: JSON.stringify(prefs),
  });

/** The IANA time zones the browser knows, UTC first; a list without `supportedValuesOf` is just UTC. */
export function timeZoneNames(): string[] {
  const intl = Intl as { supportedValuesOf?: (key: string) => string[] };
  let names: string[] = [];
  try {
    names = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    names = [];
  }
  return ["UTC", ...names.filter((n) => n !== "UTC")];
}

/** The options of a time zone select, with `current` kept when the browser does not list it. */
export function timeZoneOptions(current: string | null): { value: string; label: string }[] {
  const names = timeZoneNames();
  if (current !== null && !names.includes(current)) names.push(current);
  return names.map((n) => ({ value: n, label: n }));
}
