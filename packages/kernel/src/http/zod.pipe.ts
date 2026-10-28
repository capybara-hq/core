import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { parseWithZod } from "../infra/validation/parse-with-zod.js";

/** Validates a request parameter (usually the body) with a zod schema; see {@link parseWithZod}. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    return parseWithZod(this.schema, value);
  }
}
