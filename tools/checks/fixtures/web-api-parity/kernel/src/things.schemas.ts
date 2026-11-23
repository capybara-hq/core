import { z } from "zod";

export const CreateThingBody = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["a", "b"]),
    note: z.string().optional(),
    size: z.number().int().default(1),
  })
  .strict();
