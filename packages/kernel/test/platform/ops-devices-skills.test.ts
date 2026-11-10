import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { AgentSkillsService } from "../../src/skills/agent-skills.service.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";
import { makeZip, SKILL_MD } from "../skills/zip.js";

/**
 * Task 11b of the Platform tool: devices (personal, with the fake sandbox), the agent's own
 * skills, invocable skills and the skill change detail, against PG with the real services.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const MODEL = { provider: "model-fake", model: "fake-1" };

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let ops: PlatformOperations;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-ops-env-skills-"));
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, OBJECT_STORE, SANDBOX_FAKE],
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
          "sandbox-fake": { root },
        },
        devices: { maxPersonal: 2 },
      },
    ),
  );
  ops = k.app.get(PlatformOperations);
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerId: string;
let memberId: string;
let adminId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.skill_change_requests, capybara.devices, capybara.sandboxes, capybara.skill_versions, capybara.skills, capybara.attachments, capybara.approvals, capybara.runs, capybara.conversation_events, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  adminId = (await accounts.createLocal({ login: "adm", password: PW, displayName: "A" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};
const ctxOf = (accountId: string): OperationContext => ({
  orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "member"));
  });
};
const precheck = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};
const classOf = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.confirmFor === undefined ? o.confirm : o.confirmFor(o.input.parse(input), ctx);
};
const audits = (action: string) =>
  db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

async function agentOf(owner: string, visibility: "private" | "org") {
  const r = await k.app.get(AgentsService).create(orgId, owner, {
    definition: {
      name: "Writer",
      instructions: "Write skills.",
      model: MODEL,
      disabledTools: builtinsOff("Bash"),
      toolPolicies: {},
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      avatarUrl: null,
    },
    visibility,
  });
  return r.agent.id;
}

async function writeSkill(agentId: string, accountId: string, name: string) {
  const zip = new Uint8Array(
    makeZip([{ name: "SKILL.md", data: SKILL_MD(name, `Use for ${name} work.`) }]),
  );
  const conversationId = await createConv(
    await session(k, accountId === ownerId ? "owner" : "mem"),
    orgId,
    agentId,
  );
  return k.app.get(AgentSkillsService).register({ orgId, agentId, accountId, conversationId }, zip);
}

describe("devices", () => {
  it("registers the operations", () => {
    expect(
      ops
        .all()
        .map((o) => o.id)
        .filter((id) => id.startsWith("devices.")),
    ).toEqual([
      "devices.create",
      "devices.delete",
      "devices.get",
      "devices.list",
      "devices.rename",
      "devices.reset-files",
    ]);
  });

  it("creates and renames with a card naming the objects, lists and reads, and audits the agent", async () => {
    const ctx = ctxOf(ownerId);
    expect(await classOf("devices.create", { name: "Analysis" }, ctx)).toBe("personal");
    const s = await op("devices.create").summary?.(
      op("devices.create").input.parse({ name: "Analysis" }),
      ctx,
    );
    expect(s?.en).toContain("Analysis");
    expect(await precheck("devices.create", { name: "Analysis" }, ctx)).toEqual({ ok: true });
    const created = (await run("devices.create", { name: "Analysis" }, ctx)) as {
      device: { id: string; name: string };
    };
    expect(created.device.name).toBe("Analysis");
    const created2 = (await audits("device.created"))[0];
    expect(created2?.detail).toMatchObject({
      name: "Analysis",
      via: "agent",
      operation: "devices.create",
      agentConversationId: ctx.conversationId,
    });

    const list = (await run("devices.list", {}, ctx)) as {
      items: { id: string; name: string; isDefault: boolean }[];
      cloudAvailable: boolean;
    };
    expect(list.cloudAvailable).toBe(true);
    expect(list.items.map((e) => e.name)).toEqual(["Personal", "Analysis"]);

    const renamed = (await run(
      "devices.rename",
      { deviceId: created.device.id, name: "Reports" },
      ctx,
    )) as { device: { name: string } };
    expect(renamed.device.name).toBe("Reports");
    expect((await audits("device.renamed"))[0]?.detail).toMatchObject({
      from: "Analysis",
      to: "Reports",
      operation: "devices.rename",
    });
    const got = (await run("devices.get", { deviceId: created.device.id }, ctx)) as {
      device: { name: string; provider: string };
    };
    expect(got.device.name).toBe("Reports");
  });

  it("denies known failures before the card: taken name, the limit, another person's device", async () => {
    const ctx = ctxOf(ownerId);
    // listing makes the default device, which counts against the limit
    await run("devices.list", {}, ctx);
    await run("devices.create", { name: "Analysis" }, ctx);
    const before = (await run("devices.list", {}, ctx)) as { items: { id: string }[] };
    // renaming the default to a taken name (another case) is refused before the card
    expect(
      await precheck("devices.rename", { deviceId: before.items[0]?.id, name: "analysis" }, ctx),
    ).toMatchObject({ ok: false, code: "device.name_taken" });
    // the default plus one is the limit of 2
    expect(await precheck("devices.create", { name: "Third" }, ctx)).toMatchObject({
      ok: false,
      code: "device.limit_reached",
    });
    const mine = (await run("devices.list", {}, ctx)) as { items: { id: string }[] };
    const other = ctxOf(memberId);
    const id = mine.items[0]?.id as string;
    expect(await precheck("devices.rename", { deviceId: id, name: "X" }, other)).toMatchObject({
      ok: false,
      code: "device.not_found",
    });
    await expect(run("devices.get", { deviceId: id }, other)).rejects.toThrow(/devices\.list/);
  });
});

describe("devices: delete and reset files", () => {
  it("asks every time, warns in the card, denies before it and audits the operation", async () => {
    const ctx = ctxOf(ownerId);
    await run("devices.list", {}, ctx);
    const made = (await run("devices.create", { name: "Scratch" }, ctx)) as {
      device: { id: string };
    };
    const input = { deviceId: made.device.id };
    for (const id of ["devices.delete", "devices.reset-files"]) {
      expect(await classOf(id, input, ctx)).toBe("personal");
      expect(op(id).rememberable).toBe(false);
      const sum = await op(id).summary?.(op(id).input.parse(input), ctx);
      expect(sum?.en).toContain('"Scratch"');
      expect(sum?.en).toContain("cannot be recovered");
      expect(sum?.zh).toContain("无法恢复");
    }
    const del = await op("devices.delete").summary?.(op("devices.delete").input.parse(input), ctx);
    expect(del?.en).toContain("0 conversations using it lose their sandbox");
    expect(del?.zh).toContain("0 个对话将失去沙箱");
    const other = ctxOf(memberId);
    expect(await precheck("devices.delete", input, other)).toMatchObject({
      ok: false,
      code: "device.not_found",
    });
    expect(await precheck("devices.reset-files", input, other)).toMatchObject({
      ok: false,
      code: "device.not_found",
    });
    expect(await precheck("devices.reset-files", input, ctx)).toEqual({ ok: true });
    await run("devices.reset-files", input, ctx);
    expect((await audits("device.files_reset"))[0]?.detail).toMatchObject({
      via: "agent",
      operation: "devices.reset-files",
    });
    await run("devices.delete", input, ctx);
    expect((await audits("device.deleted"))[0]?.detail).toMatchObject({
      name: "Scratch",
      via: "agent",
      operation: "devices.delete",
    });
    expect(await precheck("devices.delete", input, ctx)).toMatchObject({
      ok: false,
      code: "device.not_found",
    });
  });
});

describe("devices: the run's own device", () => {
  it("refuses to delete or wipe the device of the run's root conversation, before the card", async () => {
    const ctx0 = ctxOf(ownerId);
    const listed = (await run("devices.list", {}, ctx0)) as {
      items: { id: string; isDefault: boolean }[];
    };
    const made = (await run("devices.create", { name: "Mine" }, ctx0)) as {
      device: { id: string };
    };
    const other = { device: { id: listed.items.find((e) => e.isDefault)?.id as string } };
    const agentId = await agentOf(ownerId, "private");
    const rootConv = await createConv(owner, orgId, agentId);
    const childConv = await createConv(owner, orgId, agentId);
    await db
      .updateTable("conversations")
      .set({ device_id: made.device.id })
      .where("id", "=", rootConv)
      .execute();
    await db
      .updateTable("conversations")
      .set({ parent_conversation_id: rootConv })
      .where("id", "=", childConv)
      .execute();
    const input = { deviceId: made.device.id };
    // the root itself, and a sub-agent below it, both run on the root's device
    for (const conversationId of [rootConv, childConv]) {
      const ctx = { ...ctxOf(ownerId), conversationId };
      for (const id of ["devices.delete", "devices.reset-files"]) {
        expect(await precheck(id, input, ctx), `${id} from ${conversationId}`).toMatchObject({
          ok: false,
          code: "device.current",
          message: expect.stringContaining("you are running in"),
        });
      }
      // another device of the person's is fine
      expect(await precheck("devices.delete", { deviceId: other.device.id }, ctx)).toEqual({
        ok: true,
      });
    }
    // from an unrelated conversation the same device can go
    expect(await precheck("devices.delete", input, ctx0)).toEqual({ ok: true });
  });
});

describe("agent skills", () => {
  it("lists an agent's own skills and its invocable skills", async () => {
    const agentId = await agentOf(ownerId, "private");
    await writeSkill(agentId, ownerId, "notes");
    const ctx = ctxOf(ownerId);
    const own = (await run("agents.skills", { agentId }, ctx)) as {
      items: { name: string; state: string }[];
    };
    expect(own.items).toMatchObject([{ name: "notes", state: "active" }]);
    const inv = (await run("agents.invocable-skills", { agentId }, ctx)) as {
      items: { name: string }[];
    };
    expect(inv.items.map((s) => s.name)).toContain("notes");
    // another person's private agent is not visible
    await expect(run("agents.skills", { agentId }, ctxOf(memberId))).rejects.toThrow(
      /agents\.list/,
    );
  });

  it("deletes a skill of a private agent as a personal write and audits the operation", async () => {
    const agentId = await agentOf(ownerId, "private");
    await writeSkill(agentId, ownerId, "notes");
    const ctx = ctxOf(ownerId);
    const skillId = ((await run("agents.skills", { agentId }, ctx)) as { items: { id: string }[] })
      .items[0]?.id as string;
    const input = { agentId, skillId };
    expect(await classOf("agents.delete-skill", input, ctx)).toBe("personal");
    expect(op("agents.delete-skill").rememberable).toBe(false);
    const s = await op("agents.delete-skill").summary?.(
      op("agents.delete-skill").input.parse(input),
      ctx,
    );
    expect(s?.en).toBe('Delete skill "notes" of agent "Writer"');
    expect(await precheck("agents.delete-skill", input, ctx)).toEqual({ ok: true });
    await run("agents.delete-skill", input, ctx);
    expect((await audits("skill.deleted"))[0]?.detail).toMatchObject({
      name: "notes",
      via: "agent",
      operation: "agents.delete-skill",
    });
    expect(await precheck("agents.delete-skill", input, ctx)).toMatchObject({
      ok: false,
      code: "skill.not_found",
    });
  });

  it("a shared agent's skill delete is an org write, and only the owner may do it", async () => {
    const agentId = await agentOf(ownerId, "org");
    await writeSkill(agentId, ownerId, "keep");
    const ctx = ctxOf(ownerId);
    const skillId = ((await run("agents.skills", { agentId }, ctx)) as { items: { id: string }[] })
      .items[0]?.id as string;
    const input = { agentId, skillId };
    expect(await classOf("agents.delete-skill", input, ctx)).toBe("org");
    // an org admin who is not the owner is refused before the card
    expect(await precheck("agents.delete-skill", input, ctxOf(adminId))).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });
});

describe("skills.get-change", () => {
  it("shows the summary without file contents, to the agent's owner and the requester only", async () => {
    const agentId = await agentOf(ownerId, "org");
    // a pending change request seeded directly: no tool creates one until org-admin review lands
    const changeId = randomUUID();
    const body = "Steps.";
    await db
      .insertInto("skill_change_requests")
      .values({
        id: changeId,
        org_id: orgId,
        agent_id: agentId,
        skill_id: null,
        proposed_version: JSON.stringify({
          skillId: randomUUID(),
          version: 1,
          manifest: {
            name: "keep",
            description: "Use for keep work.",
            files: [{ path: "SKILL.md", size: body.length, sha256: "0".repeat(64) }],
          },
        }),
        object_prefix: `skill-changes/${randomUUID()}/`,
        requested_by_account: memberId,
        requested_in_conversation: await createConv(await session(k, "mem"), orgId, agentId),
      })
      .execute();
    const r = (await run("skills.get-change", { changeId }, ctxOf(ownerId))) as {
      skillChange: Record<string, unknown>;
    };
    expect(r.skillChange).toMatchObject({
      id: changeId,
      name: "keep",
      state: "pending",
      version: 1,
      files: [{ path: "SKILL.md", size: expect.any(Number) }],
    });
    expect(JSON.stringify(r)).not.toContain("Steps.");
    expect(String(r.skillChange.next)).toContain("agents never decide");
    await expect(run("skills.get-change", { changeId }, ctxOf(adminId))).rejects.toThrow(
      /inbox\.list/,
    );
    expect(op("skills.get-change").confirm).toBe("read");
  });
});
