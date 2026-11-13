import {
  defineExtension,
  type ExtensionContext,
  type HookCall,
  orgAccess,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake of an extension that cleans up after removals: it observes the three lifecycle hooks
 * (`org.member_removed`, `agent.deleted`, `org.deleted`) and records every call in its own schema
 * (`plugin_fake_lifecycle`): table `calls` gets one row per call, `deliveries` one row per call
 * that succeeded, each with the mount and the payload. Deployment config `failTimes` (default 0):
 * the first `failTimes` calls of each (mount, payload) throw, so tests can drive the kernel's
 * retries; the count lives in PG, so it holds across replicas. Deployment config `label` (optional,
 * at most 10 characters) is overridable per org, so a test can store an org copy that does not
 * validate (an org whose effective config is invalid).
 */

const DeploymentConfig = z.object({
  /** How many calls of each (mount, payload) throw before one succeeds. */
  failTimes: z.number().int().min(0).default(0),
  /** Overridable per org; an org copy with a longer label makes that org's config invalid. */
  label: orgAccess(z.string().max(10).optional(), "override"),
});

type Db = ExtensionContext["db"];

/** Records the call, throws while it is one of the first `failTimes`, else records the delivery. */
async function handle(
  db: Db,
  mount: string,
  payload: object,
  call: HookCall | undefined,
): Promise<void> {
  const json = JSON.stringify(payload);
  await db.insertInto("calls").values({ mount, payload: json }).execute();
  const { failTimes } = DeploymentConfig.parse(call?.config ?? {});
  if (failTimes > 0) {
    const row = await db
      .selectFrom("calls")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("mount", "=", mount)
      .where("payload", "=", json)
      .executeTakeFirstOrThrow();
    if (Number(row.n) <= failTimes) throw new Error(`fake-lifecycle: call ${row.n} fails`);
  }
  await db.insertInto("deliveries").values({ mount, payload: json }).execute();
}

export default defineExtension({
  name: "fake-lifecycle",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  migrations: "../migrations",
  config: { deployment: DeploymentConfig },
  permissions: { hooks: ["org.member_removed", "agent.deleted", "org.deleted"] },
  setup(ctx) {
    ctx.hooks.on(
      "org.member_removed",
      (p, _signal, call) => handle(ctx.db, "org.member_removed", p, call),
      { mode: "observe" },
    );
    ctx.hooks.on("agent.deleted", (p, _signal, call) => handle(ctx.db, "agent.deleted", p, call), {
      mode: "observe",
    });
    ctx.hooks.on("org.deleted", (p, _signal, call) => handle(ctx.db, "org.deleted", p, call), {
      mode: "observe",
    });
  },
});
