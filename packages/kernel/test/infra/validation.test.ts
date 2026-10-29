import "reflect-metadata";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Body, Controller, Get, Module, Param, Post, Req } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { ApiError } from "../../src/errors.js";
import { ErrorFilter } from "../../src/http/error.filter.js";
import { ZodPipe } from "../../src/http/zod.pipe.js";
import { dtoRef, setupSwagger } from "../../src/infra/swagger/swagger.js";
import { KERNEL_LOGGER } from "../../src/infra/tokens.js";
import { createZodDto } from "../../src/infra/validation/create-zod-dto.js";
import { ValidationModule } from "../../src/infra/validation/validation.module.js";
import { ZBody, ZParam, ZQuery } from "../../src/infra/validation/zod-params.js";
import { createLogger } from "../../src/log.js";
import { startKernel } from "../helpers/runs.js";

const BodySchema = z.object({
  name: z.string().min(2),
  tags: z.array(z.string()).default(["x"]),
  n: z.coerce.number().int().optional(),
});
class CreateThing extends createZodDto(BodySchema, "CreateThing") {}
class ListQuery extends createZodDto(
  z.object({ limit: z.coerce.number().int().min(1).default(10) }),
) {}
class IdParam extends createZodDto(z.object({ id: z.string().uuid() })) {}

@Controller("things")
class ThingsController {
  @Post()
  create(@ZBody(CreateThing) body: CreateThing) {
    return body;
  }
  @Get()
  list(@ZQuery(ListQuery) q: ListQuery) {
    return q;
  }
  @Get(":id")
  one(@ZParam(IdParam) p: IdParam, @Param("id") raw: string) {
    return { p, raw };
  }
  @Get("req/raw")
  raw(@Req() req: { url: string }) {
    return { url: req.url };
  }
  @Post("plain")
  plain(@Body() body: { a: number }) {
    return body;
  }
}

@Module({
  imports: [ValidationModule],
  controllers: [ThingsController],
  providers: [
    { provide: KERNEL_LOGGER, useValue: createLogger("error", { write: () => {} }) },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
class TestModule {}

async function app(swagger?: boolean): Promise<NestFastifyApplication> {
  const a = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  if (swagger !== undefined) setupSwagger(a, swagger);
  await a.init();
  await a.getHttpAdapter().getInstance().ready();
  return a;
}

describe("zod DTOs and the global validation pipe", () => {
  it("validates body, query and param; applies transforms and defaults", async () => {
    const a = await app();
    try {
      const ok = await a.inject({
        method: "POST",
        url: "/things",
        payload: { name: "abc", n: "4" },
      });
      expect(ok.json()).toEqual({ name: "abc", tags: ["x"], n: 4 });
      expect((await a.inject({ method: "GET", url: "/things" })).json()).toEqual({ limit: 10 });
      expect((await a.inject({ method: "GET", url: "/things?limit=3" })).json()).toEqual({
        limit: 3,
      });
      const bad = await a.inject({ method: "GET", url: "/things?limit=0" });
      expect(bad.statusCode).toBe(400);
      const id = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
      expect((await a.inject({ method: "GET", url: `/things/${id}` })).json()).toEqual({
        p: { id },
        raw: id,
      });
      expect((await a.inject({ method: "GET", url: "/things/nope" })).statusCode).toBe(400);
    } finally {
      await a.close();
    }
  });

  it("the error body equals today's ZodPipe error", async () => {
    const a = await app();
    try {
      const res = await a.inject({
        method: "POST",
        url: "/things",
        payload: { name: "a", tags: [1] },
      });
      expect(res.statusCode).toBe(400);
      let expected: ApiError | undefined;
      try {
        new ZodPipe(BodySchema).transform({ name: "a", tags: [1] });
      } catch (e) {
        expected = e as ApiError;
      }
      const body = res.json() as { error: { code: string; message: string; details: unknown } };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.message).toBe("Request validation failed");
      expect(body.error.details).toEqual(expected?.details);
      expect(body.error.details).toEqual([
        { path: "name", message: expect.any(String) },
        { path: "tags.0", message: expect.any(String) },
      ]);
    } finally {
      await a.close();
    }
  });

  it("parameters without a DTO schema pass untouched", async () => {
    const a = await app();
    try {
      const plain = await a.inject({
        method: "POST",
        url: "/things/plain",
        payload: { a: "not-a-number" },
      });
      expect(plain.json()).toEqual({ a: "not-a-number" });
      expect((await a.inject({ method: "GET", url: "/things/req/raw" })).json()).toEqual({
        url: "/things/req/raw",
      });
    } finally {
      await a.close();
    }
  });

  it("swagger: off builds nothing, on serves /docs with the DTO's JSON Schema", async () => {
    const off = await app(false);
    try {
      expect((await off.inject({ method: "GET", url: "/docs" })).statusCode).toBe(404);
    } finally {
      await off.close();
    }
    const on = await app(true);
    try {
      expect((await on.inject({ method: "GET", url: "/docs" })).statusCode).toBe(200);
      const doc = (await on.inject({ method: "GET", url: "/docs-json" })).json() as {
        paths: Record<string, unknown>;
        components: {
          schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }>;
        };
      };
      expect(Object.keys(doc.components.schemas.CreateThing?.properties ?? {})).toEqual([
        "name",
        "tags",
        "n",
      ]);
      const post = (doc.paths["/things"] as Record<string, Record<string, unknown>>).post as {
        requestBody: { content: Record<string, { schema: unknown }> };
      };
      expect(post.requestBody.content["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/CreateThing",
      });
      expect(doc.components.schemas.CreateThing?.required).toEqual(["name"]);
      const get = (doc.paths["/things"] as Record<string, Record<string, unknown>>).get as {
        parameters: { name: string; in: string; required: boolean }[];
      };
      expect(get.parameters).toEqual([
        expect.objectContaining({ name: "limit", in: "query", required: false }),
      ]);
      const one = (doc.paths["/things/{id}"] as Record<string, Record<string, unknown>>).get as {
        parameters: { name: string; in: string; required: boolean }[];
      };
      expect(one.parameters).toContainEqual(
        expect.objectContaining({ name: "id", in: "path", required: true }),
      );
      expect(dtoRef(CreateThing)).toEqual({ $ref: "#/components/schemas/CreateThing" });
    } finally {
      await on.close();
    }
  });
});

describe("http.swagger on the kernel", () => {
  it("/docs is 404 by default and served when http.swagger is true", async () => {
    const pgc = await startTestPostgres();
    const rd = await startTestRedis();
    const masterKey = Buffer.alloc(32, 7).toString("base64");
    const boot = async (swagger?: boolean) => {
      const k = await startKernel(
        KernelConfigSchema.parse({
          roles: ["api"],
          db: { url: pgc.url, poolMax: 3 },
          redis: { url: rd.url },
          masterKey,
          marketplaces: { official: { enabled: false } },
          http: { port: 0, ...(swagger === undefined ? {} : { swagger }) },
        }),
        { env: {}, logger: createLogger("error", { write: () => {} }) },
      );
      return k;
    };
    try {
      const off = await boot();
      try {
        expect((await off.http.inject({ method: "GET", url: "/docs" })).statusCode).toBe(404);
      } finally {
        await off.close();
      }
      const on = await boot(true);
      try {
        expect((await on.http.inject({ method: "GET", url: "/docs" })).statusCode).toBe(200);
        expect((await on.http.inject({ method: "GET", url: "/docs-json" })).statusCode).toBe(200);
      } finally {
        await on.close();
      }
    } finally {
      await Promise.all([pgc.stop(), rd.stop()]);
    }
  }, 180_000);
});
