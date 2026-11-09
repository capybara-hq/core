import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import {
  clearAppearance,
  importLook,
  LOOK,
  orgRows,
  platformRows,
} from "../catalog/appearance-env.js";
import { type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { enableExtensions } from "../helpers/runs.js";
import { setThemeScope } from "../themes/theme-env.js";

/**
 * The Platform operations of a plugin's suggested appearance (client extensions spec §6.5, plan
 * Task 12): `plugins.platform-apply-appearance` (super admin) and `plugins.apply-appearance` (org
 * admins) mirror the two routes, are confirmed every time and never remembered; the route's dry
 * run is the card (summary) and the precheck, and only the confirmed call writes.
 */

let env: OrgEnv;
let ops: PlatformOperations;
let itemId: string;
let themeId: string;

const PLATFORM_OP = "plugins.platform-apply-appearance";
const ORG_OP = "plugins.apply-appearance";

beforeAll(async () => {
  env = await startOrgEnv();
  ops = env.k.app.get(PlatformOperations);
  ({ itemId, themeId } = await importLook(env));
  await enableExtensions(env.db, env.orgId, LOOK);
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await clearAppearance(env);
  await setThemeScope(env, themeId, "all");
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const ctxOf = (accountId: string): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});

const parse = (id: string, input: unknown) => op(id).input.parse(input);

describe("suggested appearance operations", { timeout: 60_000 }, () => {
  it("both operations are confirmed and never rememberable", () => {
    const platform = op(PLATFORM_OP);
    expect(platform.confirm).toBe("platform");
    expect(platform.rememberable).toBe(false);
    expect(platform.authz).toEqual({ superAdmin: true });
    expect(platform.mirrors).toEqual(["POST /api/v1/admin/catalog/items/:id/appearance"]);
    const org = op(ORG_OP);
    expect(org.confirm).toBe("org");
    expect(org.rememberable).toBe(false);
    expect(org.authz).toEqual({ orgAction: "org.update" });
    expect(org.mirrors).toEqual(["POST /api/v1/orgs/:orgId/extensions/:extension/appearance"]);
    // the dry run is the card, never an input of a confirmed write
    expect(() => parse(PLATFORM_OP, { itemId, dryRun: true })).toThrow();
    expect(() => parse(ORG_OP, { extension: LOOK, dryRun: true })).toThrow();
  });

  it("the dry run is the preview", async () => {
    const ctx = ctxOf(env.rootId);
    const input = parse(PLATFORM_OP, { itemId });
    expect(await op(PLATFORM_OP).precheck?.(input, ctx)).toEqual({ ok: true });
    const card = await op(PLATFORM_OP).summary?.(input, ctx);
    expect(card?.en).toContain("shell.brand");
    expect(card?.en).toContain("conversation.empty");
    expect(card?.en).toContain("Look");
    expect(card?.zh).toContain("外观");
    // the card and the precheck wrote nothing
    expect(await platformRows(env)).toEqual({});
    const result = await op(PLATFORM_OP).run(input, ctx);
    expect(result).toMatchObject({ theme: { from: null, to: themeId } });
    expect(await platformRows(env)).toEqual({
      uiTheme: { id: themeId },
      uiArrangement: {
        "shell.brand": { use: `${LOOK}/brand` },
        "conversation.empty": { use: `${LOOK}/empty` },
      },
    });
    const audits = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "deployment.settings.updated")
      .execute();
    expect(audits.map((a) => a.detail)).toContainEqual(
      expect.objectContaining({
        via: "agent",
        operation: PLATFORM_OP,
        appearance: expect.any(Object),
      }),
    );

    // the org operation: the same, at org level
    const orgCtx = ctxOf(env.bossId);
    const orgInput = parse(ORG_OP, { extension: LOOK });
    const orgCard = await op(ORG_OP).summary?.(orgInput, orgCtx);
    expect(orgCard?.en).toContain("shell.brand");
    expect(await orgRows(env, env.orgId)).toEqual({});
    await op(ORG_OP).run(orgInput, orgCtx);
    expect(await orgRows(env, env.orgId)).toMatchObject({
      theme: { id: themeId, personal: "allowed" },
    });
  });

  it("the precheck refuses a theme that cannot be set, before any card", async () => {
    await setThemeScope(env, themeId, "optional");
    const r = await op(PLATFORM_OP).precheck?.(parse(PLATFORM_OP, { itemId }), ctxOf(env.rootId));
    expect(r).toMatchObject({ ok: false, code: "theme.not_available" });
    const o = await op(ORG_OP).precheck?.(parse(ORG_OP, { extension: LOOK }), ctxOf(env.bossId));
    expect(o).toMatchObject({ ok: false, code: "theme.not_available" });
    expect(await platformRows(env)).toEqual({});
  });
});
