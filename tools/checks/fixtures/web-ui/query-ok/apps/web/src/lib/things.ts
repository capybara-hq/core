import { apiFetch } from "./api";

export async function removeThing(id: string) {
  await apiFetch<void>(`/api/v1/things/${id}`, { method: "DELETE" });
}
export const shortName = (s: string) => s.slice(0, 8);
