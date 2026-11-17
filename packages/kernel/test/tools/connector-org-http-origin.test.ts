import {
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Agent, buildConnector } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EXTENSION_NET_SEAMS } from "../../src/ctx/net.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import { OrgNetworkAllowances } from "../../src/orgs/network-allowances.service.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  enableConnectorExtensions,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

// An http connector endpoint reached through ctx.net end to end (plugin safe fetch spec): the
// fake connector's endpoint names `mcp.internal`, which the fake DNS resolves to a private address
// (10.0.0.5); every connection the kernel pins to that address goes to the loopback fake MCP
// server. Only an org whose allowances list the `http://mcp.internal:<port>` origin reaches it.

const INTERNAL = "mcp.internal";
const INTERNAL_IP = "10.0.0.5";
const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let mcp: FakeMcpServer;
let owner: Account;
let endpointUrl: string;
/** The addresses the kernel pinned ctx.net connections to. */
const pinned: string[][] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  mcp = await startFakeMcpServer({
    tools: [
      {
        name: "search",
        description: "Search documents",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
        handler: ({ args }) => ({ content: [{ type: "text", text: `hits for ${args.q}` }] }),
      },
    ],
  });
  const port = new URL(mcp.url).port;
  endpointUrl = `http://${INTERNAL}:${port}/mcp`;
  const connect = buildConnector({});
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      // no loopback exemption: the internal name resolves to a private address
      net: { allowInsecureLoopback: false },
      http: { port: 0 },
      extensions: [MODEL_FAKE, fakeExtensionEntry("fake-connector")],
      extensionConfig: { "fake-connector": {} },
      extensionPermissions: { autoApprove: true },
    }),
    {
      env: {},
      logger: createLogger("error", { write: () => {} }),
      overrides: [
        {
          provide: EXTENSION_NET_SEAMS,
          useValue: {
            lookup: async (host) => {
              if (host !== INTERNAL) throw new Error(`no such host ${host}`);
              return [{ address: INTERNAL_IP, family: 4 }];
            },
            dispatcherFor: (ips) => {
              pinned.push(ips);
              return new Agent({
                connect: (opts, cb) => connect({ ...opts, hostname: "127.0.0.1" }, cb),
              });
            },
          },
        },
      ],
    },
  );
  raw = createDb(pgc.url, 5);
  owner = await accountsFor(kernelDb(raw)).createLocal({
    login: "owner",
    password: PW,
    displayName: "Owner",
  });
});

afterAll(async () => {
  await k?.close();
  await mcp?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("an http connector endpoint behind an org's origin allowance", () => {
  it("is reached for the org that allows the origin and refused for another org", async () => {
    const req = await session(k, "owner");
    const allowed = await createOrg(req, "Allowed");
    const other = await createOrg(req, "Other");
    for (const orgId of [allowed, other]) await enableConnectorExtensions(k, orgId);
    await k.app
      .get(OrgNetworkAllowances)
      .add(allowed, `http://${INTERNAL}:${new URL(mcp.url).port}`, { accountId: owner.id });

    const install = (orgId: string) =>
      req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/connectors`,
        payload: {
          name: "Internal docs",
          slug: "internal",
          connector: "fake",
          endpoint: { url: endpointUrl },
          auth: { type: "none" },
        },
      });

    const ok = await install(allowed);
    expect(ok.statusCode, ok.body).toBe(201);
    const created = ok.json() as { connector: { status: string; tools: { name: string }[] } };
    expect(created.connector.status).toBe("active");
    expect(created.connector.tools.map((t) => t.name)).toEqual(["search"]);
    expect(pinned).toContainEqual([INTERNAL_IP]);
    expect(mcp.requests.length).toBeGreaterThan(0);

    const pinnedBefore = pinned.length;
    const requestsBefore = mcp.requests.length;
    const refused = await install(other);
    expect(refused.statusCode).not.toBe(201);
    expect(refused.json()).toMatchObject({ error: { code: "connector.connect_failed" } });
    expect(refused.body).toContain("NetDeniedError");
    // refused before any connection: nothing pinned, nothing reached the server
    expect(pinned.length).toBe(pinnedBefore);
    expect(mcp.requests.length).toBe(requestsBefore);
  });
});
