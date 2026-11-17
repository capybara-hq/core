import { fileURLToPath } from "node:url";
import { AccountsService } from "@capybara-hq/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestPostgres, startTestRedis, type TestContainer } from "../src/containers.js";
import {
  createOrg,
  enableModelProviders,
  login,
  startTestKernel,
  TEST_PASSWORD,
  type TestKernel,
  testKernelConfig,
} from "../src/kernel-helpers.js";

// enableModelProviders: a model provider is on only in the orgs that enabled it, so a plugin's
// kernel test switches the loaded providers on in its org before saving an agent.

const MODEL_FAKE = fileURLToPath(
  new URL("../../../plugins/model-fake/src/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startTestKernel(
    testKernelConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE] }),
  );
  await k.app
    .get(AccountsService)
    .createLocal({ login: "owner", password: TEST_PASSWORD, displayName: "Owner" });
});

afterAll(async () => {
  await k?.close();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("enableModelProviders", () => {
  it("switches the loaded providers on in the org, once; an agent can then be saved there", async () => {
    const owner = await login(k, "owner");
    const orgId = await createOrg(owner);
    const agent = {
      method: "POST" as const,
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Helper",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      },
    };
    const refused = await owner(agent);
    expect(refused.statusCode, refused.body).toBe(400);
    expect((refused.json() as { error: { code: string } }).error.code).toBe(
      "agent.model_unavailable",
    );

    expect(await enableModelProviders(owner, orgId, ["other"])).toEqual([]);
    expect(await enableModelProviders(owner, orgId)).toEqual(["model-fake"]);
    expect(await enableModelProviders(owner, orgId)).toEqual([]);
    const saved = await owner(agent);
    expect(saved.statusCode, saved.body).toBe(201);
  });
});
