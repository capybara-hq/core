import {
  type ContextProvider,
  type ContextRequest,
  defineExtension,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake of a `context@1` provider (memory plugin spec §6.1). Its behavior follows its
 * deployment config, which the kernel passes back as the request's effective `config`:
 * - `mode: "ok"` (default): returns `{ text }` (`text` default "fake context");
 * - `mode: "null"`: returns null (nothing to add);
 * - `mode: "throw"`: throws;
 * - `mode: "hang"`: waits until the request's signal aborts, then rejects with its reason.
 * Every call is recorded (the request without its signal) on `globalThis.__fakeContext`
 * ({@link fakeContextProbe}; in-process kernels only). It also registers the tool `note` (default
 * policy allow, `sources: ["web", "channel_dm"]`), so `tools` in a request lists
 * `plugin__fake-context__note` only in one-to-one conversations. Its org config (`label`, default
 * "") exists only so a test can store an org copy that no longer validates.
 */

const DeploymentConfig = z.object({
  text: z.string().default("fake context"),
  mode: z.enum(["ok", "null", "throw", "hang"]).default("ok"),
});

/** An org-only config (all defaults), so a test can make the org's stored copy invalid. */
const OrgConfig = z.object({ label: z.string().default("") });

/** One `provide` call: the request the kernel sent, without its signal. */
export type FakeContextCall = Omit<ContextRequest, "signal">;

/** The probe tests read: every `provide` call of this process. */
export function fakeContextProbe(): { calls: FakeContextCall[] } {
  const g = globalThis as { __fakeContext?: { calls: FakeContextCall[] } };
  g.__fakeContext ??= { calls: [] };
  return g.__fakeContext;
}

/** Rejects with the signal's reason once it aborts. */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const NOTE: ToolSpec = {
  name: "note",
  description:
    "Acknowledge a note. Offered only in web and direct-message conversations. Test fixture only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  defaultPolicy: "allow",
  sources: ["web", "channel_dm"],
};

const provider: ContextProvider = {
  async provide(req) {
    const { signal, ...call } = req;
    fakeContextProbe().calls.push(call);
    const cfg = DeploymentConfig.parse(req.config ?? {});
    if (cfg.mode === "throw") throw new Error("fake-context: scripted failure");
    if (cfg.mode === "hang") await hang(signal);
    if (cfg.mode === "null") return null;
    return { text: cfg.text };
  },
};

export default defineExtension({
  name: "fake-context",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["context@1"],
  config: { deployment: DeploymentConfig, org: OrgConfig },
  permissions: { tools: ["note"] },
  setup(ctx) {
    ctx.provide("context@1", provider);
    ctx.tools.register(NOTE, async () => ({ content: [{ type: "text", text: "Noted." }] }));
  },
});
