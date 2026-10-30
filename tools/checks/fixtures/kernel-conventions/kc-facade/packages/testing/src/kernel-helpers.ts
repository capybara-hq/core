import type { Kernel } from "@capybara-hq/kernel"; // expect: kc-facade

export async function boot(): Promise<Kernel> { // expect: kc-facade
  return {} as never;
}
export const kernelName = "Kernel";
