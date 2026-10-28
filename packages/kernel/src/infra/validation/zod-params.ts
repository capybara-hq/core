import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { ZodDtoClass } from "./create-zod-dto.js";

// esbuild, tsx and the kernel's own tsc build emit no decorator metadata, so a parameter's type is
// never visible to a pipe. These decorators name the DTO explicitly instead: they pass the raw
// request part through and hand the DTO to the global ZodValidationPipe as the argument's `data`.
const part = (key: "body" | "query" | "params") =>
  createParamDecorator(
    (_dto: ZodDtoClass, ctx: ExecutionContext) =>
      ctx.switchToHttp().getRequest<FastifyRequest>()[key],
  );

const body = part("body");
const query = part("query");
const params = part("params");

/** The request body, validated against the DTO's schema; the parameter is the schema's output. */
export const ZBody = (dto: ZodDtoClass): ParameterDecorator => body(dto);
/** The query string, validated against the DTO's schema. */
export const ZQuery = (dto: ZodDtoClass): ParameterDecorator => query(dto);
/** The path parameters, validated against the DTO's schema. */
export const ZParam = (dto: ZodDtoClass): ParameterDecorator => params(dto);
