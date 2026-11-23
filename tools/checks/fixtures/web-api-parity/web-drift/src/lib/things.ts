import { apiFetch } from "./api";

const enc = encodeURIComponent;
const base = (orgId: string) => `/api/v1/orgs/${enc(orgId)}/things`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// web-api-field-gone: `color` is not in the kernel's Thing
export const gone = (orgId: string) =>
  apiFetch<{ things: { id: string; color: string }[] }>(base(orgId));

// web-api-type: the kernel returns a Date (a string) and `ownerId` may be null
export const typed = (orgId: string, id: string) =>
  apiFetch<{ thing: { createdAt: number; ownerId: string } }>(`${base(orgId)}/${enc(id)}`);

// web-api-enum, both ways: the kernel can return "c"; the web lists "d"
export const enums = (orgId: string) =>
  apiFetch<{ things: { kind: "a" | "b" | "d" }[] }>(base(orgId));

// web-api-type: the kernel may leave `meta` out
export const absent = (orgId: string, id: string) =>
  apiFetch<{ thing: { meta: { color: string } } }>(`${base(orgId)}/${enc(id)}`);

// web-api-body-field, web-api-body-enum, web-api-body-type, web-api-body-required
export const create = (
  orgId: string,
  input: { kind: "a" | "z"; note: number; color: string },
) => apiFetch<{ thing: { id: string } }>(base(orgId), post(input));

// web-api-route-gone
export const removed = (orgId: string, id: string) =>
  apiFetch<void>(`${base(orgId)}/${enc(id)}/gone`, post({}));
