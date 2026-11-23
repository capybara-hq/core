import { apiFetch } from "./api";

type ThingKind = "a" | "b" | "c";

export interface Thing {
  id: string;
  name: string;
  kind: ThingKind;
  createdAt: string;
  ownerId: string | null;
  meta?: { color: string };
  /** @clientOnly Set by the web, never by the kernel. */
  label?: string;
}

const enc = encodeURIComponent;
const base = (orgId: string) => `/api/v1/orgs/${enc(orgId)}/things`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body !== undefined && { body: JSON.stringify(body) }),
});
const send = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const listThings = (orgId: string) => apiFetch<{ things: Thing[] }>(base(orgId));

/** `archived` is a literal segment: it is not `:id`. */
export const listArchived = (orgId: string, q: string) =>
  apiFetch<{ things: Thing[]; total: number }>(`${base(orgId)}/archived${q === "" ? "" : `?${q}`}`);

export const getThing = (orgId: string, id: string) =>
  apiFetch<{ thing: Thing }>(`${base(orgId)}/${enc(id)}`);

export const createThing = (orgId: string, input: { name: string; kind: "a" | "b"; size?: number }) =>
  apiFetch<{ thing: Thing }>(base(orgId), post(input));

export const renameThing = (orgId: string, id: string, name: string) =>
  apiFetch<{ name: string }>(`${base(orgId)}/${enc(id)}/name`, send("PUT", { name }));
