import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "../errors.js";

/** 用 Zod schema 校验请求参数（通常是 body）；失败抛 `validation_failed`，details 逐条给出路径与原因。 */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    throw new ApiError(
      "validation_failed",
      "Request validation failed",
      r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
}
