import { z } from "zod";

export const KernelConfigSchema = z.object({
  extensions: z.array(z.string()).default([]),
  extensionHost: z
    .object({
      directory: z.string().default("/var/lib/capybara/plugins"),
    })
    .default({}),
  catalog: z.object({}).default({}),
  marketplaces: z.object({}).default({}),
});
