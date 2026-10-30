// Ported from octok-platform libs/common/src/validation (owner-approved, 2026-10-28).
import { type ArgumentMetadata, Injectable, type PipeTransform } from "@nestjs/common";
import { zodSchemaOf } from "./create-zod-dto.js";
import { parseWithZod } from "./parse-with-zod.js";

/**
 * Global pipe (`APP_PIPE`): validates the arguments declared with `@ZBody(Dto)` / `@ZQuery(Dto)` /
 * `@ZParam(Dto)` (the DTO arrives as `metadata.data`; a parameter whose metatype is a DTO, where
 * the build emits decorator metadata, is validated too) and returns the parse output (transforms
 * and defaults applied). Failures are `validation_failed` ({@link parseWithZod}). Any
 * other argument (primitives, the raw request, other custom decorators) passes untouched.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema =
      metadata.type === "custom"
        ? zodSchemaOf(metadata.data)
        : metadata.type === "body" || metadata.type === "query" || metadata.type === "param"
          ? zodSchemaOf(metadata.metatype)
          : undefined;
    return schema === undefined ? value : parseWithZod(schema, value);
  }
}
