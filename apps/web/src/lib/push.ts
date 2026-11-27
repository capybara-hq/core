import { apiFetch } from "./api";

/** The push categories a person switches (kernel `PUSH_CATEGORIES`); every one is on by default. */
export const PUSH_CATEGORIES = ["waiting", "replies", "tasks", "automations"] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

/** The four switches (`GET` / `PUT /api/v1/me/push-preferences`). */
export type PushPreferences = Record<PushCategory, boolean>;

/** One of the person's registrations (`GET /api/v1/me/push-registrations`); never carries a token. */
export interface PushRegistrationView {
  id: string;
  platform: "ios" | "android";
  appId: string;
  provider: string;
  deviceName: string;
  locale: "zh" | "en";
  createdAt: string;
  lastSeenAt: string;
  /** Posted by the session making the request: this device. */
  current: boolean;
}

/** What `POST /api/v1/me/push-registrations` takes: the shell's registration, the language and a name. */
export interface PushRegistrationInput {
  platform: "ios" | "android";
  appId: string;
  provider: string;
  token: string;
  locale: "zh" | "en";
  deviceName: string;
}

const BASE = "/api/v1/me/push-registrations";

export const listPushRegistrations = () =>
  apiFetch<{ items: PushRegistrationView[] }>(BASE).then((r) => r.items);

export const postPushRegistration = (input: PushRegistrationInput) =>
  apiFetch<{ id: string }>(BASE, { method: "POST", body: JSON.stringify(input) });

export const deletePushRegistration = (id: string) =>
  apiFetch<void>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });

export const getPushPreferences = () => apiFetch<PushPreferences>("/api/v1/me/push-preferences");

/** A partial update: only the switches given change; the answer has all four. */
export const putPushPreferences = (patch: Partial<PushPreferences>) =>
  apiFetch<PushPreferences>("/api/v1/me/push-preferences", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
