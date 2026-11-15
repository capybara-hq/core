import { fetch as undiciFetch, request } from "undici"; // expect: kc-global-fetch

export async function get(url: string) {
  await request(url);
  return undiciFetch(url);
}
