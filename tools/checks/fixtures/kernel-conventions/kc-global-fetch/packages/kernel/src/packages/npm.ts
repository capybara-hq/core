import {
  fetch as undiciFetch, // expect: kc-global-fetch
  request, // expect: kc-global-fetch
} from "undici";

export async function get(url: string) {
  await request(url);
  return undiciFetch(url);
}
