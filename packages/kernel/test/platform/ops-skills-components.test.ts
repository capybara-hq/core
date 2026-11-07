import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import {
  importSkill,
  importTemplate,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  setBuiltin,
  setScope,
  startOrgEnv,
} from "../catalog/org-env.js";
import { createOrg, enableExtensions } from "../helpers/runs.js";

/**
 * Task 6 of phase 2 of the Platform tool: the skill and component operations against PG with the
 * real services (spec §14). Operations run by
 * `op.run(input, ctx)`, refusals by `availability()`. Super-admin results never name another org
 * (Review Focus 4): asserted on the JSON string.
 */

let env: OrgEnv;
let ops: PlatformOperations;
let org2: string;
const ORG2_NAME = "Beta Corp";

beforeAll(async () => {
  env = await startOrgEnv();
  ops = env.k.app.get(PlatformOperations);
  org2 = await createOrg(env.root, ORG2_NAME);
}, 240_000);
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetOrgCatalog(env);
  await enableExtensions(env.db, org2, "fake-connector");
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const facts = (role: ActorFacts["role"], over: Partial<ActorFacts> = {}): ActorFacts => ({
  role,
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: true,
  setting: "on",
  ...over,
});

const ctxOf = (accountId: string): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});

/** Parses like the tool does, then runs; a service refusal becomes the tool's error. */
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "orgAdmin"));
  });
};

/** The operation's precheck, as the tool's callPolicy runs it before the card. */
const precheck = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};

/** The card summary of a write, as the tool's callPolicy reads it. */
const summarize = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.summary?.(o.input.parse(input), ctx);
};

const _failure = async (p: Promise<unknown>): Promise<ToolError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ToolError);
  return e as ToolError;
};

const audits = (action: string) =>
  env.db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

const _tokenInput = () => ({ endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } });

const plugin = (itemId: string) =>
  op("plugins.set-enabled").run(
    op("plugins.set-enabled").input.parse({ itemId, enabled: true }),
    ctxOf(env.bossId),
  );

const skillComponent = async (name: string): Promise<string> =>
  (
    await env.db
      .selectFrom("platform_skills")
      .select("id")
      .where("name", "=", name)
      .executeTakeFirstOrThrow()
  ).id;

describe("registration", () => {
  it("registers the skills and component operations", () => {
    const ids = ops.all().map((o) => o.id);
    for (const id of [
      "skills.available",
      "skills.delete",
      "skills.delete-preview",
      "skills.disable-preview",
      "skills.set-enabled",
      "skills.set-shareable",
      "agent-templates.available",
      "agent-templates.disable-preview",
      "agent-templates.set-enabled",
      "connectors.template-disable-preview",
      "connectors.set-template-enabled",
      "plugins.components",
      "plugins.component-versions",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("offers the switches to org admins only and the reads to members", () => {
    expect(availability(op("skills.set-enabled"), facts("member")).ok).toBe(false);
    expect(availability(op("skills.set-enabled"), facts("admin"))).toEqual({ ok: true });
    expect(availability(op("skills.delete"), facts("member")).ok).toBe(false);
    expect(availability(op("skills.available"), facts("member"))).toEqual({ ok: true });
    expect(availability(op("plugins.components"), facts("admin")).ok).toBe(false);
    expect(availability(op("plugins.components"), facts("admin", { isSuperAdmin: true }))).toEqual({
      ok: true,
    });
  });
});

describe("skills.set-enabled", () => {
  it("lists, previews, switches off with the preview's confirm and back on", async () => {
    const item = await importSkill(env, { name: "pdf-tools" });
    await setScope(env, item, "optional");
    const before = (await run("skills.available", {}, ctxOf(env.memId))) as {
      items: { id: string; state: string; name: string }[];
    };
    expect(before.items).toMatchObject([{ name: "pdf-tools", state: "off" }]);
    await plugin(item);
    const id = await skillComponent("pdf-tools");
    const on = (await run("skills.available", {}, ctxOf(env.memId))) as typeof before;
    expect(on.items).toMatchObject([{ id, state: "on" }]);

    const preview = (await run("skills.disable-preview", { skillId: id }, ctxOf(env.bossId))) as {
      confirm: string;
    };
    expect(preview.confirm).toMatch(/^[0-9a-f]{64}$/);
    const off = { skillId: id, enabled: false, confirm: preview.confirm };
    expect(await precheck("skills.set-enabled", off, ctxOf(env.bossId))).toEqual({ ok: true });
    expect(await summarize("skills.set-enabled", off, ctxOf(env.bossId))).toEqual({
      zh: "在本组织停用平台技能「pdf-tools」：0 个智能体在用",
      en: 'Switch off platform skill "pdf-tools" in the org: 0 agents use it',
    });
    // a confirm that is not the preview's is refused before the card
    expect(
      await precheck("skills.set-enabled", { ...off, confirm: "0".repeat(64) }, ctxOf(env.bossId)),
    ).toMatchObject({ ok: false, code: "plugin.switch_stale" });
    await run("skills.set-enabled", off, ctxOf(env.bossId));
    expect(
      ((await run("skills.available", {}, ctxOf(env.memId))) as typeof before).items,
    ).toMatchObject([{ id, state: "off" }]);
    const [row] = await audits("component.org_switched");
    expect(row?.detail).toMatchObject({
      via: "agent",
      operation: "skills.set-enabled",
      from: null,
      to: false,
    });
    await run("skills.set-enabled", { skillId: id, enabled: true }, ctxOf(env.bossId));
    expect(
      ((await run("skills.available", {}, ctxOf(env.memId))) as typeof before).items,
    ).toMatchObject([{ id, state: "on" }]);
  });

  it("refuses to switch off a built-in plugin's component before the card, with the reason", async () => {
    const item = await importSkill(env, { name: "pdf-tools" });
    await setBuiltin(env, item);
    const id = await skillComponent("pdf-tools");
    const p = (await run("skills.disable-preview", { skillId: id }, ctxOf(env.bossId))) as {
      locked: boolean;
    };
    expect(p.locked).toBe(true);
    expect(
      await precheck(
        "skills.set-enabled",
        { skillId: id, enabled: false, confirm: "already-off" },
        ctxOf(env.bossId),
      ),
    ).toMatchObject({ ok: false, code: "plugin.scope_locked" });
  });

  it("denies an unknown component with component.not_found", async () => {
    expect(
      await precheck(
        "skills.set-enabled",
        { skillId: randomUUID(), enabled: true },
        ctxOf(env.bossId),
      ),
    ).toMatchObject({ ok: false, code: "component.not_found" });
  });

  it("switches connector templates through the connectors operation", async () => {
    const item = await importTemplate(env);
    await setBuiltin(env, item);
    const t = (await run("connectors.templates", {}, ctxOf(env.memId))) as {
      items: { id: string }[];
    };
    const id = t.items[0]?.id ?? "";
    expect(
      await precheck(
        "connectors.set-template-enabled",
        { templateId: id, enabled: false, confirm: "already-off" },
        ctxOf(env.bossId),
      ),
    ).toMatchObject({ ok: false, code: "plugin.scope_locked" });
  });

  it("lists no agent template when none is offered", async () => {
    expect(await run("agent-templates.available", {}, ctxOf(env.memId))).toMatchObject({
      items: [],
      total: 0,
    });
  });
});

describe("skills.set-shareable and skills.delete", () => {
  const create = (name: string) =>
    run(
      "skills.create",
      { name, description: "Use when testing.", body: "# Steps\n\n1. Test." },
      ctxOf(env.bossId),
    ) as Promise<{ skill: { id: string } }>;

  it("shares an org skill and deletes it, auditing both as the agent's", async () => {
    const skill = (await create("temp-skill")).skill;
    expect(
      await summarize(
        "skills.set-shareable",
        { skillId: skill.id, shareable: true },
        ctxOf(env.bossId),
      ),
    ).toEqual({
      zh: "允许把组织技能「temp-skill」共享给其他组织",
      en: 'Allow org skill "temp-skill" to be shared with other orgs',
    });
    await run("skills.set-shareable", { skillId: skill.id, shareable: true }, ctxOf(env.bossId));
    const [shared] = await audits("catalog.shareable_changed");
    expect(shared?.detail).toMatchObject({ via: "agent", operation: "skills.set-shareable" });

    const prev = (await run("skills.delete-preview", { skillId: skill.id }, ctxOf(env.bossId))) as {
      preview: { outcome: string };
    };
    expect(prev.preview.outcome).toBe("removed");
    expect(
      await summarize("skills.delete", { skillId: skill.id }, ctxOf(env.bossId)),
    ).toMatchObject({
      en: 'Delete org skill "temp-skill": 0 agents lose it',
    });
    await run("skills.delete", { skillId: skill.id }, ctxOf(env.bossId));
    const [del] = await audits("skill.deleted");
    expect(del?.detail).toMatchObject({
      via: "agent",
      operation: "skills.delete",
      name: "temp-skill",
    });
    expect(await precheck("skills.delete", { skillId: skill.id }, ctxOf(env.bossId))).toMatchObject(
      {
        ok: false,
        code: "skill.not_found",
      },
    );
  });
});

describe("plugins.components", () => {
  it("lists platform components for the super admin without naming orgs", async () => {
    const item = await importSkill(env, { name: "pdf-tools" });
    await setScope(env, item, "named", [org2]);
    const id = await skillComponent("pdf-tools");
    const list = await run("plugins.components", { kind: "skill" }, ctxOf(env.rootId));
    expect(list).toMatchObject({ items: [{ id, name: "pdf-tools" }], otherOrgComponents: 0 });
    const versions = await run(
      "plugins.component-versions",
      { kind: "skill", componentId: id },
      ctxOf(env.rootId),
    );
    expect(versions).toMatchObject({ versions: [{ version: "1" }] });
    for (const v of [list, versions]) expect(JSON.stringify(v)).not.toContain(org2);
  });
});
