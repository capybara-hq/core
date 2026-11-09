import { UI_SLOTS } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/** The slot catalog route (UI slots spec §3): any signed-in person, no org. */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let guest: Req;
let loner: Req;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }), {
    env: {},
  });
  const accounts = accountsFor(db);
  const ids: Record<string, string> = {};
  for (const login of ["owner", "guest", "loner"]) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  const owner = await session(k, "owner");
  guest = await session(k, "guest");
  loner = await session(k, "loner");
  const orgId = await createOrg(owner);
  await testMembers(db).add(orgId, ids.guest as string, "guest", ids.owner as string);
}, 180_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("GET /api/v1/ui/slots", () => {
  it("GET /api/v1/ui/slots answers any signed-in person", async () => {
    for (const who of [guest, loner]) {
      const r = await who({ method: "GET", url: "/api/v1/ui/slots" });
      expect(r.statusCode, r.body).toBe(200);
      const { slots } = r.json() as { slots: { id: string }[] };
      expect(slots).toEqual(JSON.parse(JSON.stringify(UI_SLOTS)));
      expect(slots.map((s) => s.id).sort()).toEqual(
        [
          "agent.detail.section",
          "conversation.panel",
          "conversation.properties.section",
          "conversation.tool-result.card",
          "file.preview",
          "org.page",
          "org.settings.section",
          "platform.page",
          "shell.brand",
          "shell.overlay",
          "conversation.empty",
          "conversation.composer.frame",
        ].sort(),
      );
    }
  });

  it("anonymous gets auth.required", async () => {
    const r = await k.http.inject({ method: "GET", url: "/api/v1/ui/slots" });
    expect(r.statusCode).toBe(401);
    expect((r.json() as { error: { code: string } }).error.code).toBe("auth.required");
  });
});
