"use client";

import {
  deletePushRegistration,
  getPushPreferences,
  listPushRegistrations,
  type PushCategory,
  type PushPreferences,
  putPushPreferences,
} from "../push";
import { defineQuery } from "./define";
import { keys } from "./keys";
import { useAppMutation } from "./mutation";

/** The person's push registrations (the devices that receive notifications). */
export const pushRegistrationsQuery = (accountId: string) =>
  defineQuery({
    key: keys.account(accountId).pushRegistrations(),
    fn: () => listPushRegistrations(),
    freshness: "mine",
  });

/** The person's four push switches. */
export const pushPreferencesQuery = (accountId: string) =>
  defineQuery({
    key: keys.account(accountId).pushPreferences(),
    fn: () => getPushPreferences(),
    freshness: "mine",
  });

/** Removes one registration (`DELETE`), then the list is read again. */
export function useRemovePushRegistration(accountId: string) {
  return useAppMutation<string, void>({
    fn: (id) => deletePushRegistration(id),
    invalidates: () => [keys.account(accountId).pushRegistrations()],
  });
}

/** Changes one switch: `PUT` with that key alone, then the switches are read again. */
export function useSetPushPreference(accountId: string) {
  return useAppMutation<{ category: PushCategory; enabled: boolean }, PushPreferences>({
    fn: ({ category, enabled }) => putPushPreferences({ [category]: enabled }),
    invalidates: () => [keys.account(accountId).pushPreferences()],
  });
}
