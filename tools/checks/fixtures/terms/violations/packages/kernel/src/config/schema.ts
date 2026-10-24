import { z } from "zod";

export const KernelConfigSchema = z.object({
  extensions: z.array(z.string()).default([]),
  pluginHost: z.object({}).default({}),
});
