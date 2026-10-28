import { KERNEL_CONFIG, KERNEL_DB } from "./tokens.js"; // expect: kc-legacy

export const API_DEPS = Symbol("API_DEPS"); // expect: kc-legacy
export interface ApiDeps { // expect: kc-legacy
  db: unknown;
}
export const m = { registerFrom: () => [KERNEL_DB, KERNEL_CONFIG] }; // expect: kc-legacy
