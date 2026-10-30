import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { ApiBody, ApiParam, ApiQuery } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import type { ZodDtoClass } from "./create-zod-dto.js";

// esbuild, tsx and the kernel's own tsc build emit no decorator metadata, so a parameter's type is
// never visible to a pipe or to @nestjs/swagger. These decorators name the DTO explicitly: they
// pass the raw request part through, hand the DTO to the global ZodValidationPipe as the argument's
// `data`, and describe the parameter to swagger on the method.
const part = (key: "body" | "query" | "params") =>
  createParamDecorator(
    (_dto: ZodDtoClass, ctx: ExecutionContext) =>
      ctx.switchToHttp().getRequest<FastifyRequest>()[key],
  );

const body = part("body");
const query = part("query");
const params = part("params");

type Jsonish = { properties?: Record<string, object>; required?: string[] };

function onMethod(
  decorators: MethodDecorator[],
  target: object,
  key: string | symbol | undefined,
): void {
  if (key === undefined) return;
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (desc === undefined) return;
  for (const d of decorators) d(target, key, desc);
}

function perProperty(dto: ZodDtoClass, make: typeof ApiQuery | typeof ApiParam): MethodDecorator[] {
  const js = dto.jsonSchema() as Jsonish;
  const required = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {}).map(([name, schema]) =>
    make({ name, required: required.has(name), schema } as never),
  );
}

/** The request body, validated against the DTO's schema; the parameter is the schema's output. */
export const ZBody =
  (dto: ZodDtoClass): ParameterDecorator =>
  (target, key, index) => {
    body(dto)(target, key, index);
    const schema =
      dto.dtoName === undefined
        ? dto.jsonSchema()
        : { $ref: `#/components/schemas/${dto.dtoName}` };
    onMethod([ApiBody({ schema: schema as never })], target, key);
  };

/** The query string, validated against the DTO's schema; each property is a swagger query parameter. */
export const ZQuery =
  (dto: ZodDtoClass): ParameterDecorator =>
  (target, key, index) => {
    query(dto)(target, key, index);
    onMethod(perProperty(dto, ApiQuery), target, key);
  };

/** The path parameters, validated against the DTO's schema; each property is a swagger path parameter. */
export const ZParam =
  (dto: ZodDtoClass): ParameterDecorator =>
  (target, key, index) => {
    params(dto)(target, key, index);
    onMethod(perProperty(dto, ApiParam), target, key);
  };
