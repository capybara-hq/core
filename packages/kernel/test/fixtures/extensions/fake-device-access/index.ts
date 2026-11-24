import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";
import { callScopeOf } from "../../../../src/tools/call-scope.js";

/**
 * Test only: a browser-like extension tool whose service saw hosts refused by the device's network
 * allowlist. Until the kernel side of `ctx.deviceAccess.reportBlockedHosts` writes the call scope,
 * this fixture writes it itself through `callScopeOf` (kernel tests only: real extensions see only
 * the SDK). `navigate` reports `blocked` on the first invocation of a logical call; a re-run of the
 * same call (same idempotency key) reports `blockedAgain` when given, else loads the page. Every invocation's key is recorded in
 * `globalThis.__fakeDeviceAccessCalls` for the test to count ({@link fakeDeviceAccessCalls}).
 */
export function fakeDeviceAccessCalls(): string[] {
  const g = globalThis as { __fakeDeviceAccessCalls?: string[] };
  g.__fakeDeviceAccessCalls ??= [];
  return g.__fakeDeviceAccessCalls;
}

export default defineExtension({
  name: "fake-device-access",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["navigate"] },
  setup(ctx: ExtensionContext) {
    ctx.tools.register(
      {
        name: "navigate",
        description: "Test only: opens a URL in a fake browser on the conversation's device.",
        defaultPolicy: "allow",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            deviceId: { type: "string" },
            blocked: { type: "array", items: { type: "string" } },
            blockedAgain: { type: "array", items: { type: "string" } },
          },
          required: ["url", "deviceId"],
        },
      },
      async (input, call) => {
        const {
          url,
          deviceId,
          blocked = [],
          blockedAgain = [],
        } = input as { url: string; deviceId: string; blocked?: string[]; blockedAgain?: string[] };
        const key = call.idempotencyKey ?? call.callId;
        const calls = fakeDeviceAccessCalls();
        calls.push(key);
        const first = calls.filter((k) => k === key).length === 1;
        const scope = callScopeOf(call);
        const refused = first ? blocked : blockedAgain;
        if (refused.length > 0 && scope !== null) {
          scope.blocked = { deviceId, hosts: new Set(refused) };
          return { content: [{ type: "text" as const, text: `Could not load ${url}.` }] };
        }
        return { content: [{ type: "text" as const, text: `Loaded ${url}.` }] };
      },
    );
  },
});
