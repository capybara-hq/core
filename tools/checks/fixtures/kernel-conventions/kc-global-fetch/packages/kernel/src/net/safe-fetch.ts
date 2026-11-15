import { fetch as undiciFetch } from "undici";

// net/ is where outbound HTTP lives
export async function safeFetch(url: string) {
  await fetch(url);
  return undiciFetch(url);
}
