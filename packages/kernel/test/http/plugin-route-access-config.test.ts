import type { ThrottlerStorage } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { Route } from "../../src/ctx/create-ctx.js";
import { ApiError } from "../../src/errors.js";
import type { EffectiveConfig } from "../../src/extensions/effective-config.js";
import { PluginRouteAccess } from "../../src/http/plugin-route-access.js";
import type { AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";

/**
 * The effective config step of extension route access (unit: stub services, no database): an org
 * embed token reaches the config check, whose outcome decides the answer.
 */

const unused = <T>(): T =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error("not used by the embed path");
      },
    },
  ) as T;

const access = (config: EffectiveConfig) =>
  new PluginRouteAccess(
    unused<KernelDb>(),
    unused<AccountsService>(),
    unused<ApiTokenService>(),
    { get: async () => config },
    unused<ThrottlerStorage>(),
  );

const route: Route = {
  plugin: "p",
  method: "GET",
  path: "/plugins/p/ui/data",
  access: "embed",
  handler: async () => new Response(null),
  verifyEmbed: async () => ({
    plugin: "p",
    scope: "org",
    orgId: "o1",
    accountId: "a1",
    role: "member",
    contribution: "page",
    exp: Math.floor(Date.now() / 1000) + 60,
  }),
};

const req = { headers: { authorization: "Bearer embed.token" }, query: {} } as FastifyRequest;
const reply = {} as FastifyReply;

const refusal = async (config: EffectiveConfig) => {
  const err = await access(config)
    .resolve(route, req, reply, {})
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
};

describe("PluginRouteAccess effective config", () => {
  it("a valid config reaches the caller", async () => {
    const caller = await access({ ok: true, config: { baseUrl: "x" }, source: "copy" }).resolve(
      route,
      req,
      reply,
      {},
    );
    expect(caller).toMatchObject({ access: "embed", orgId: "o1", config: { baseUrl: "x" } });
  });

  it("an invalid config: 409 extension.needs_config", async () => {
    const err = await refusal({
      ok: false,
      issues: [{ path: "baseUrl", segments: ["baseUrl"], message: "Required" }],
    });
    expect(err.code).toBe("extension.needs_config");
    expect(err.status).toBe(409);
  });

  it("the extension not running on this replica: 503 extension.unavailable, not needs_config", async () => {
    const err = await refusal({ ok: false, issues: [], notRunning: true });
    expect(err.code).toBe("extension.unavailable");
    expect(err.status).toBe(503);
  });
});
