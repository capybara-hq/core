import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "../errors.js";

/**
 * Parses `value` with a zod schema and returns the output (transforms and defaults applied); a
 * failure throws `validation_failed` whose details list each issue's path and message. The one
 * implementation behind both {@link ZodPipe} and the global `ZodValidationPipe`.
 */
export function parseWithZod<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new ApiError(
    "validation_failed",
    "Request validation failed",
    r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  );
}

/** Validates a request parameter (usually the body) with a zod schema; see {@link parseWithZod}. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    return parseWithZod(this.schema, value);
  }
}
