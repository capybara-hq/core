import type { Kysely } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { loadPeople, type PersonRef } from "../identity/account-avatar.js";
import type { ConversationEvent } from "./events.js";

/** The payload keys that name a person: a message's author, a run's trigger, who decided or stopped. */
const PERSON_KEYS = ["authorAccountId", "triggerAccountId", "byAccountId"] as const;

/** Every account id the events name (an id may repeat; null is skipped). */
export function accountIdsOfEvents(events: readonly ConversationEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    const payload = e.payload as Record<string, unknown> | null;
    for (const key of PERSON_KEYS) {
      const v = payload?.[key];
      if (typeof v === "string") ids.add(v);
    }
  }
  return [...ids];
}

/**
 * The `people` sidecar of an events or trajectory response (account profile spec §5.4): one
 * query for every account the events name, plus `extraIds`. Computed at read time; the logged
 * payloads keep their ids only. An account that no longer exists is absent.
 */
export async function peopleOfEvents(
  db: Kysely<KernelDatabase>,
  events: readonly ConversationEvent[],
  extraIds: readonly string[] = [],
): Promise<Record<string, PersonRef>> {
  const people = await loadPeople(db, [...accountIdsOfEvents(events), ...extraIds]);
  return Object.fromEntries(people);
}
