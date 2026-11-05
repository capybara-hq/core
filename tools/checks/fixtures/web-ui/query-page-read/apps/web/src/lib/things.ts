import { apiFetch } from "./api";

export const listThings = () => apiFetch<string[]>("/api/v1/things");
