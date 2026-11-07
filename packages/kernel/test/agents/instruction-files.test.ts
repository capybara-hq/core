import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AGENTS_MD_STARTER,
  joinInstructionFiles,
  readInstructionFiles,
} from "../../src/agents/instruction-files.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import { BEHAVIOR_RULES, buildModelRequest } from "../../src/runtime/context/build.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { Log, MODEL } from "../runtime/context/fixtures.js";

const MODEL_REF = { provider: "model-fake", model: "fake-1" };

describe("joinInstructionFiles / readInstructionFiles", () => {
  it("one AGENTS.md joins to exactly its content", () => {
    expect(joinInstructionFiles([{ name: "AGENTS.md", content: "Be helpful.\n" }])).toBe(
      "Be helpful.\n",
    );
    expect(joinInstructionFiles([{ name: "AGENTS.md", content: "" }])).toBe("");
  });

  it("several files join with # name headers in order", () => {
    const joined = joinInstructionFiles([
      { name: "AGENTS.md", content: "You are a helper." },
      { name: "WORKFLOW.md", content: "1. Read.\n2. Write." },
      { name: "STYLE.md", content: "Be terse." },
    ]);
    expect(joined).toBe(
      "# AGENTS.md\n\nYou are a helper.\n\n# WORKFLOW.md\n\n1. Read.\n2. Write.\n\n# STYLE.md\n\nBe terse.",
    );
  });

  it("an old definition reads as one AGENTS.md", () => {
    expect(readInstructionFiles({ instructions: "Old prompt." })).toEqual([
      { name: "AGENTS.md", content: "Old prompt." },
    ]);
    const files = [
      { name: "AGENTS.md", content: "a" },
      { name: "B.md", content: "b" },
    ];
    expect(readInstructionFiles({ instructions: "ignored", instructionFiles: files })).toEqual(
      files,
    );
  });
});

describe("prompt files over HTTP", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let k: TestKernel;
  let raw: ReturnType<typeof createDb>;
  let redis: Redis;
  let accounts: AccountsService;
  let owner: Account;
  const PW = "correct horse battery";

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    k = await startKernel(
      KernelConfigSchema.parse({
        db: { url: pgc.url, poolMax: 5 },
        redis: { url: rd.url },
        masterKey: Buffer.alloc(32, 7).toString("base64"),
        marketplaces: { official: { enabled: false } },
        http: { port: 0 },
        ...MODEL_PLUGINS_CONFIG,
      }),
      { env: {}, logger: createLogger("error", { write: () => {} }) },
    );
    raw = createDb(pgc.url, 5);
    redis = new Redis(rd.url);
    accounts = accountsFor(kernelDb(raw));
  }, 120_000);
  afterAll(async () => {
    await k?.close();
    redis?.disconnect();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });
  beforeEach(async () => {
    await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
    await redis.flushdb();
    owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  });

  type Req = ReturnType<typeof asUser>;
  type AgentJson = {
    id: string;
    currentVersion: number;
    definition: { instructions: string; instructionFiles?: { name: string; content: string }[] };
  };
  const errCode = (res: { json(): unknown }) =>
    (res.json() as { error?: { code?: string } }).error?.code;

  async function setup(): Promise<{ req: Req; orgId: string }> {
    expect(owner.id).toBeTruthy();
    const req = asUser(k.http, cookieJar());
    const login = await req({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { login: "owner", password: PW },
    });
    expect(login.statusCode).toBe(200);
    const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
    expect(org.statusCode).toBe(201);
    return { req, orgId: (org.json() as { org: { id: string } }).org.id };
  }

  const create = (req: Req, orgId: string, definition: Record<string, unknown>) =>
    req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: { name: "Helper", model: MODEL_REF, ...definition },
        visibility: "org",
      },
    });

  const twoFiles = [
    { name: "AGENTS.md", content: "You are a helper." },
    { name: "WORKFLOW.md", content: "Plan, then act." },
  ];

  it("saving instructionFiles stores the join as instructions; a matching instructions is accepted", async () => {
    const { req, orgId } = await setup();
    const res = await create(req, orgId, { instructionFiles: twoFiles });
    expect(res.statusCode).toBe(201);
    const agent = (res.json() as { agent: AgentJson }).agent;
    expect(agent.definition.instructionFiles).toEqual(twoFiles);
    expect(agent.definition.instructions).toBe(joinInstructionFiles(twoFiles));

    const same = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: {
        definition: {
          ...agent.definition,
          instructionFiles: twoFiles,
          instructions: joinInstructionFiles(twoFiles),
        },
        expectedVersion: 1,
      },
    });
    expect(same.statusCode).toBe(200);
    expect((same.json() as { agent: AgentJson }).agent.currentVersion).toBe(1);
  });

  it("a mismatching instructions is 400 agent.instructions_mismatch", async () => {
    const { req, orgId } = await setup();
    const bad = await create(req, orgId, { instructionFiles: twoFiles, instructions: "Other." });
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("agent.instructions_mismatch");

    const ok = await create(req, orgId, { instructions: "Be helpful." });
    expect(ok.statusCode).toBe(201);
    const agent = (ok.json() as { agent: AgentJson }).agent;
    const patch = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: {
        definition: {
          ...agent.definition,
          instructionFiles: twoFiles,
          instructions: "Be helpful.",
        },
      },
    });
    expect(patch.statusCode).toBe(400);
    expect(errCode(patch)).toBe("agent.instructions_mismatch");
    const after = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agent.id}` });
    expect((after.json() as { agent: AgentJson }).agent.currentVersion).toBe(1);
  });

  it("limits: duplicate names, 21 files, 100 001 characters, zero files, a name without .md", async () => {
    const { req, orgId } = await setup();
    const cases: unknown[] = [
      [
        { name: "AGENTS.md", content: "a" },
        { name: "AGENTS.md", content: "b" },
      ],
      Array.from({ length: 21 }, (_, i) => ({ name: `F${i}.md`, content: "x" })),
      [{ name: "AGENTS.md", content: "x".repeat(100_001) }],
      // the join's headers count: two files whose contents alone fit
      [
        { name: "AGENTS.md", content: "x".repeat(50_000) },
        { name: "B.md", content: "x".repeat(50_000) },
      ],
      [],
      [{ name: "AGENTS", content: "x" }],
      [{ name: "a/b.md", content: "x" }],
      [{ name: `${"n".repeat(65)}.md`, content: "x" }],
    ];
    for (const instructionFiles of cases) {
      const res = await create(req, orgId, { instructionFiles });
      expect(res.statusCode, JSON.stringify(instructionFiles).slice(0, 80)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const twenty = Array.from({ length: 20 }, (_, i) => ({ name: `F${i}.md`, content: "x" }));
    expect((await create(req, orgId, { instructionFiles: twenty })).statusCode).toBe(201);
  });

  it("file names refuse control, bidi and format characters", async () => {
    const { req, orgId } = await setup();
    for (const name of ["A\u0007.md", "A\n.md", "evil\u202Egnp.md", "A\u200B.md", "A\uFEFF.md"]) {
      const res = await create(req, orgId, { instructionFiles: [{ name, content: "x" }] });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    // ZWJ / ZWNJ stay allowed, as in titles
    const ok = await create(req, orgId, {
      instructionFiles: [{ name: "\u0646\u200C\u0645.md", content: "x" }],
    });
    expect(ok.statusCode).toBe(201);
    // CJK names are ordinary names
    const cjk = await create(req, orgId, {
      instructionFiles: [
        { name: "AGENTS.md", content: "a" },
        { name: "工作流程.md", content: "b" },
      ],
    });
    expect(cjk.statusCode).toBe(201);
    expect((cjk.json() as { agent: AgentJson }).agent.definition.instructionFiles?.[1]?.name).toBe(
      "工作流程.md",
    );
  });

  it("file names are unique ignoring case", async () => {
    const { req, orgId } = await setup();
    const res = await create(req, orgId, {
      instructionFiles: [
        { name: "AGENTS.md", content: "a" },
        { name: "agents.md", content: "b" },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
  });

  it("a new agent with no prompt gets the AGENTS.md starter; a request with only instructions keeps working", async () => {
    const { req, orgId } = await setup();
    const res = await create(req, orgId, {});
    expect(res.statusCode).toBe(201);
    const def = (res.json() as { agent: AgentJson }).agent.definition;
    expect(def.instructionFiles).toEqual([{ name: "AGENTS.md", content: AGENTS_MD_STARTER }]);
    expect(def.instructions).toBe(AGENTS_MD_STARTER);
    expect(AGENTS_MD_STARTER.length).toBeGreaterThan(0);

    const old = await create(req, orgId, { instructions: "Be helpful." });
    expect(old.statusCode).toBe(201);
    const oldDef = (old.json() as { agent: AgentJson }).agent.definition;
    expect(oldDef.instructions).toBe("Be helpful.");
    expect(oldDef).not.toHaveProperty("instructionFiles");
  });

  it("an unrelated save sending the joined text keeps the files; a changed text drops them", async () => {
    const { req, orgId } = await setup();
    const res = await create(req, orgId, { instructionFiles: twoFiles });
    const agent = (res.json() as { agent: AgentJson }).agent;
    const url = `/api/v1/orgs/${orgId}/agents/${agent.id}`;
    const { instructionFiles: _f, ...withoutFiles } = agent.definition as Record<string, unknown>;

    // the form's save: instructions (the join) only, another field edited the same way it was
    const same = await req({
      method: "PATCH",
      url,
      payload: { definition: withoutFiles, expectedVersion: 1 },
    });
    expect(same.statusCode).toBe(200);
    const kept = (same.json() as { agent: AgentJson }).agent;
    expect(kept.currentVersion).toBe(1);
    expect(kept.definition.instructionFiles).toEqual(twoFiles);

    const tools = await req({
      method: "PATCH",
      url,
      payload: {
        definition: { ...withoutFiles, disabledTools: [{ kind: "builtin", name: "Platform" }] },
        expectedVersion: 1,
      },
    });
    expect(tools.statusCode).toBe(200);
    const v2 = (tools.json() as { agent: AgentJson }).agent;
    expect(v2.currentVersion).toBe(2);
    expect(v2.definition.instructionFiles).toEqual(twoFiles);
    expect(v2.definition.instructions).toBe(joinInstructionFiles(twoFiles));

    const changed = await req({
      method: "PATCH",
      url,
      payload: { definition: { ...withoutFiles, disabledTools: [], instructions: "New text." } },
    });
    expect(changed.statusCode).toBe(200);
    const v3 = (changed.json() as { agent: AgentJson }).agent;
    expect(v3.currentVersion).toBe(3);
    expect(v3.definition.instructions).toBe("New text.");
    expect(v3.definition).not.toHaveProperty("instructionFiles");
  });

  it("an update given neither field keeps the current prompt; one AGENTS.md keeps an old agent's text", async () => {
    const { req, orgId } = await setup();
    const res = await create(req, orgId, { instructionFiles: twoFiles });
    const agent = (res.json() as { agent: AgentJson }).agent;
    const url = `/api/v1/orgs/${orgId}/agents/${agent.id}`;
    const {
      instructions: _i,
      instructionFiles: _f,
      ...rest
    } = agent.definition as Record<string, unknown>;
    const keep = await req({ method: "PATCH", url, payload: { definition: rest } });
    expect(keep.statusCode).toBe(200);
    const kept = (keep.json() as { agent: AgentJson }).agent;
    expect(kept.currentVersion).toBe(1);
    expect(kept.definition.instructionFiles).toEqual(twoFiles);

    const old = await create(req, orgId, { instructions: "Be helpful." });
    const oldAgent = (old.json() as { agent: AgentJson }).agent;
    const edited = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${oldAgent.id}`,
      payload: {
        definition: {
          ...oldAgent.definition,
          instructions: undefined,
          instructionFiles: [{ name: "AGENTS.md", content: "Be helpful." }],
        },
      },
    });
    expect(edited.statusCode).toBe(200);
    expect((edited.json() as { agent: AgentJson }).agent.definition.instructions).toBe(
      "Be helpful.",
    );
  });

  it("instructions stays the model-visible field", async () => {
    const { req, orgId } = await setup();
    const res = await create(req, orgId, { instructionFiles: twoFiles });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { agent: AgentJson }).agent.id;
    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${id}` });
    const agent = (
      got.json() as { agent: { definition: Parameters<typeof buildModelRequest>[0]["agent"] } }
    ).agent.definition;
    const log = new Log();
    log.user("hi");
    const { request } = buildModelRequest({
      events: log.events,
      agent,
      agentVersion: 1,
      model: MODEL,
      step: 0,
    });
    expect(request.system).toEqual([
      { text: `${BEHAVIOR_RULES}\n\n${joinInstructionFiles(twoFiles)}`, cache: true },
    ]);
  });
});
