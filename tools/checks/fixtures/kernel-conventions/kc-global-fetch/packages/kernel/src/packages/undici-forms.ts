import type { Dispatcher } from "undici";
import * as undici from "undici"; // expect: kc-global-fetch
import Undici from "undici"; // expect: kc-global-fetch

export { Agent } from "undici"; // expect: kc-global-fetch

export async function viaForms(url: string, d?: Dispatcher) {
  const required = require("undici"); // expect: kc-global-fetch
  const loaded = await import("undici"); // expect: kc-global-fetch
  return [undici.fetch(url), Undici, required, loaded, d];
}
