import type { KernelConfig } from "../config/schema.js";

export interface SupervisorDeps {
  config: () => KernelConfig; // expect: kc-config
  limits: (orgId: string) => KernelConfig;
}
export function make(config: () => KernelConfig) {} // expect: kc-config
