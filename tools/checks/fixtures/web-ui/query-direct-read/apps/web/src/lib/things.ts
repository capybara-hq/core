import { apiFetch } from "./api";

export const listThings = () => apiFetch<string[]>("/api/v1/things");
export async function removeThing(id: string) {
  await apiFetch<void>(`/api/v1/things/${id}`, { method: "DELETE" });
}
export const refreshThings = () => listThings();
export const shortName = (s: string) => s.slice(0, 8);
