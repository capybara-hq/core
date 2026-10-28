// Ported from octok-platform libs/common/src/swagger (owner-approved, 2026-10-28).
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { registeredZodDtos } from "../validation/create-zod-dto.js";

/** A `$ref` to a named DTO's schema, for `@ApiBody({ schema: dtoRef(Dto) })` and friends. */
export function dtoRef(dto: { readonly dtoName: string | undefined }): { $ref: string } {
  if (dto.dtoName === undefined) throw new Error("dtoRef: the DTO has no name");
  return { $ref: `#/components/schemas/${dto.dtoName}` };
}

/** Builds the OpenAPI document: the routes Nest found plus every named zod DTO's JSON Schema. */
export function buildSwaggerDocument(app: INestApplication, version: string): OpenAPIObject {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("Capybara kernel API").setVersion(version).build(),
  );
  const schemas: Record<string, unknown> = { ...(doc.components?.schemas ?? {}) };
  for (const dto of registeredZodDtos()) {
    if (dto.dtoName !== undefined) schemas[dto.dtoName] = dto.jsonSchema();
  }
  doc.components = { ...doc.components, schemas: schemas as never };
  return doc;
}

/**
 * Serves the swagger UI at `/docs` (JSON at `/docs-json`) when `enabled`; otherwise does nothing
 * and builds no document. The routes sit outside Nest's guards, so they are unauthenticated: the
 * option is for development and trials (`http.swagger`, default false).
 */
export function setupSwagger(app: INestApplication, enabled: boolean, version = "0"): void {
  if (!enabled) return;
  SwaggerModule.setup("docs", app, buildSwaggerDocument(app, version), {
    jsonDocumentUrl: "docs-json",
  });
}
