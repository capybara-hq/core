// Ported from octok-platform libs/common/src/validation/create-i18n-zod-dto.ts (owner-approved, 2026-10-28).
import { z } from "zod";

/** A class carrying a zod schema; the global validation pipe validates parameters typed with one. */
export interface ZodDtoClass<S extends z.ZodType = z.ZodType> {
  new (): z.infer<S>;
  readonly schema: S;
  /** The name the swagger document lists the schema under. */
  readonly dtoName: string | undefined;
  /** The schema as JSON Schema (output side, as the pipe returns it). */
  jsonSchema(): Record<string, unknown>;
}

const registry = new Set<ZodDtoClass>();

/** Every DTO created so far (the swagger document lists the named ones). */
export function registeredZodDtos(): readonly ZodDtoClass[] {
  return [...registry];
}

/**
 * Creates a DTO class from a zod schema (nestjs-zod does not support Nest 12, so the kernel has its
 * own, same shape as octok's `createI18nZodDto`). Use it as the metatype of `@Body()`, `@Query()`
 * or `@Param()`: `class CreateX extends createZodDto(schema, "CreateX") {}`. The instance type is
 * the schema's output type.
 */
export function createZodDto<S extends z.ZodType>(schema: S, name?: string): ZodDtoClass<S> {
  class ZodDto {
    static readonly schema = schema;
    static readonly dtoName = name;
    static jsonSchema(): Record<string, unknown> {
      return z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Record<
        string,
        unknown
      >;
    }
  }
  registry.add(ZodDto as unknown as ZodDtoClass);
  return ZodDto as unknown as ZodDtoClass<S>;
}

/** The DTO's schema when `metatype` is one, else undefined. */
export function zodSchemaOf(metatype: unknown): z.ZodType | undefined {
  if (typeof metatype !== "function") return undefined;
  const s = (metatype as { schema?: unknown }).schema;
  return s instanceof z.ZodType ? s : undefined;
}

/** What `@ZBody` / `@ZQuery` / `@ZParam` hand to the global pipe as the argument's `data`. */
export function isZodDto(value: unknown): value is ZodDtoClass {
  return zodSchemaOf(value) !== undefined;
}
