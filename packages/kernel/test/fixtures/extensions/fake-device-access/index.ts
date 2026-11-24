import { readFileSync } from "node:fs";
import {
  type DeviceServiceSpec,
  defineExtension,
  type ExtensionContext,
  type ToolCallContext,
} from "@capybara-hq/plugin-sdk";

/**
 * Test only: a browser-like extension on `ctx.deviceAccess` with one device service, `echo` (the
 * kernel tests' framed echo service).
 *
 * - `navigate` reports hosts its "service" saw refused (`ctx.deviceAccess.reportBlockedHosts`, with
 *   the URL): `blocked` on the first invocation of a logical call; a re-run of the same call (same
 *   idempotency key) reports `blockedAgain` when given, else loads the page. With `service: true`
 *   it first starts and asks the echo service (so the report is about the device those calls
 *   resolved), then awaits `globalThis.__fakeDeviceAccessBeforeReport` when a test set one. Every
 *   invocation's key is recorded in `globalThis.__fakeDeviceAccessCalls`
 *   ({@link fakeDeviceAccessCalls}).
 * - `echo` starts the echo service and answers its echo of `text`.
 * - `handoff` asks the person (`InputRequired`, one boolean field `done`) and answers what they
 *   said.
 */
export function fakeDeviceAccessCalls(): string[] {
  const g = globalThis as { __fakeDeviceAccessCalls?: string[] };
  g.__fakeDeviceAccessCalls ??= [];
  return g.__fakeDeviceAccessCalls;
}

/** A hook `navigate` with `service: true` awaits before it reports (set by a test, then cleared). */
type Hooked = { __fakeDeviceAccessBeforeReport?: (() => Promise<void>) | undefined };

export function setFakeDeviceAccessBeforeReport(fn: (() => Promise<void>) | undefined): void {
  (globalThis as Hooked).__fakeDeviceAccessBeforeReport = fn;
}

const beforeReport = () => (globalThis as Hooked).__fakeDeviceAccessBeforeReport;

/** The echo service's spec (its script read from the kernel tests' fixtures). */
export function echoServiceSpec(): DeviceServiceSpec {
  const script = readFileSync(new URL("../../services/echo-service.mjs", import.meta.url));
  return {
    name: "echo",
    runtime: "node",
    entry: "echo.mjs",
    args: [],
    files: { "echo.mjs": new Uint8Array(script) },
  };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export default defineExtension({
  name: "fake-device-access",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["navigate", "echo", "handoff"], deviceAccess: { services: ["echo"] } },
  setup(ctx: ExtensionContext) {
    const echo = async (call: ToolCallContext, body: string): Promise<string> => {
      await ctx.deviceAccess.ensureService(call, echoServiceSpec());
      const answer = await ctx.deviceAccess.request(call, {
        service: "echo",
        body: new TextEncoder().encode(body),
        timeoutMs: 10_000,
      });
      return new TextDecoder().decode(answer);
    };
    ctx.tools.register(
      {
        name: "navigate",
        description: "Test only: opens a URL in a fake browser on the conversation's device.",
        defaultPolicy: "allow",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            service: { type: "boolean" },
            blocked: { type: "array", items: { type: "string" } },
            blockedAgain: { type: "array", items: { type: "string" } },
          },
          required: ["url"],
        },
      },
      async (input, call) => {
        const {
          url,
          service = false,
          blocked = [],
          blockedAgain = [],
        } = input as {
          url: string;
          service?: boolean;
          blocked?: string[];
          blockedAgain?: string[];
        };
        const key = call.idempotencyKey ?? call.callId;
        const calls = fakeDeviceAccessCalls();
        calls.push(key);
        const first = calls.filter((k) => k === key).length === 1;
        if (service) await echo(call, url);
        await beforeReport()?.();
        const refused = first ? blocked : blockedAgain;
        if (refused.length > 0) {
          ctx.deviceAccess.reportBlockedHosts(call, refused, { url });
          return text(`Could not load ${url}.`);
        }
        return text(`Loaded ${url}.`);
      },
    );
    ctx.tools.register(
      {
        name: "echo",
        description: "Test only: sends text to the echo device service and returns its answer.",
        defaultPolicy: "allow",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      async (input, call) => text(await echo(call, (input as { text: string }).text)),
    );
    ctx.tools.register(
      {
        name: "handoff",
        description: "Test only: asks the user to finish something and waits for them.",
        defaultPolicy: "allow",
        inputSchema: { type: "object", properties: {} },
      },
      async (_input, call) => {
        if (call.resume !== undefined)
          return text(`done: ${JSON.stringify(call.resume.answer?.done ?? null)}`);
        return {
          kind: "input_required" as const,
          form: {
            title: "Finish in the browser",
            fields: [{ key: "done", label: "Done", schema: { type: "boolean" }, required: true }],
          },
        };
      },
    );
  },
});
