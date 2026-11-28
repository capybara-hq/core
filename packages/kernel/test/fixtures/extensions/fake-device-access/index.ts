import { readFileSync } from "node:fs";
import {
  type DeviceServiceSpec,
  defineExtension,
  type ExtensionContext,
  isLoopbackGrantHost,
  type ServiceBlockedHost,
  type ToolCallContext,
} from "@capybara-hq/plugin-sdk";

/** A refused host as a test gives it: a bare name (layer `device`) or a host with its layer. */
type Refused = string | ServiceBlockedHost;

/** The report of `refused` (a bare name is a `device`-layer refusal). */
const reported = (refused: readonly Refused[]): ServiceBlockedHost[] =>
  refused.map((r) => (typeof r === "string" ? { host: r, layer: "device" } : r));

/**
 * The loopback refusal a `url` naming a loopback grant host gives (`127.0.0.1`, `[::1]`,
 * `localhost`: layer `address`, class `loopback`, the URL's port), or null for any other URL.
 */
const loopbackRefusal = (url: string): ServiceBlockedHost | null => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!isLoopbackGrantHost(host)) return null;
  const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { host, port, layer: "address", class: "loopback" };
};

/** A JSON schema item for {@link Refused}. */
const REFUSED_ITEM = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: { host: { type: "string" }, layer: { type: "string" } },
      required: ["host", "layer"],
    },
  ],
};

/**
 * Test only: a browser-like extension on `ctx.deviceAccess` with one device service, `echo` (the
 * kernel tests' framed echo service).
 *
 * - `navigate` reports hosts its "service" saw refused (`ctx.deviceAccess.reportBlockedHosts`, with
 *   the URL): `blocked` (layer `device`, or each entry's own layer when given as
 *   `{ host, layer }`) on the first invocation of a logical call; a re-run of the same call (same
 *   idempotency key) reports `blockedAgain` when given (its second invocation only; a third loads
 *   the page), else loads the page. With `service: true`
 *   it first starts and asks the echo service (so the report is about the device those calls
 *   resolved), then awaits `globalThis.__fakeDeviceAccessBeforeReport` when a test set one. Every
 *   invocation's key is recorded in `globalThis.__fakeDeviceAccessCalls`
 *   ({@link fakeDeviceAccessCalls}). A `url` naming a loopback host (`http://127.0.0.1:3999/`)
 *   adds the loopback refusal `{ host, port, layer: "address", class: "loopback" }` to the first
 *   invocation's report (service `echo`; the extension declares
 *   `permissions.deviceAccess.loopbackPorts`).
 * - `echo` starts the echo service and answers its echo of `text`.
 * - `grant` calls `ctx.deviceAccess.grantLoopbackPort` for `port` from inside the tool call (as
 *   the call's account and conversation) and answers the refusal as `<code>: <message>`, or
 *   `granted <port>`.
 * - `handoff` asks the person (`InputRequired`, one boolean field `done`) and answers what they
 *   said; with `service: true` it first starts and asks the echo service (a launch reviewed in
 *   the round that asks), and with `blocked` it also reports those hosts refused in that round.
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
  permissions: {
    tools: ["navigate", "echo", "handoff", "grant"],
    deviceAccess: { services: ["echo"], loopbackPorts: true },
  },
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
            blocked: { type: "array", items: REFUSED_ITEM },
            blockedAgain: { type: "array", items: REFUSED_ITEM },
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
          blocked?: Refused[];
          blockedAgain?: Refused[];
        };
        const key = call.idempotencyKey ?? call.callId;
        const calls = fakeDeviceAccessCalls();
        calls.push(key);
        const n = calls.filter((k) => k === key).length;
        const first = n === 1;
        if (service) await echo(call, url);
        await beforeReport()?.();
        const loopback = first ? loopbackRefusal(url) : null;
        const refused = [
          ...(loopback !== null ? [loopback] : []),
          ...reported(first ? blocked : n === 2 ? blockedAgain : []),
        ];
        if (refused.length > 0) {
          ctx.deviceAccess.reportBlockedHosts(call, refused, { url, service: "echo" });
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
        name: "grant",
        description: "Test only: grants a local port of the device from inside the tool call.",
        defaultPolicy: "allow",
        inputSchema: {
          type: "object",
          properties: { port: { type: "number" } },
          required: ["port"],
        },
      },
      async (input, call) => {
        try {
          const g = await ctx.deviceAccess.grantLoopbackPort({
            orgId: call.orgId,
            accountId: call.accountId,
            conversationId: call.conversationId,
            service: "echo",
            port: (input as { port: number }).port,
          });
          return text(`granted ${g.port}`);
        } catch (e) {
          const err = e as { code?: string; message?: string };
          return text(`${err.code ?? "error"}: ${err.message ?? String(e)}`);
        }
      },
    );
    ctx.tools.register(
      {
        name: "handoff",
        description: "Test only: asks the user to finish something and waits for them.",
        defaultPolicy: "allow",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "boolean" },
            blocked: { type: "array", items: { type: "string" } },
          },
        },
      },
      async (input, call) => {
        if (call.resume !== undefined)
          return text(`done: ${JSON.stringify(call.resume.answer?.done ?? null)}`);
        const { service = false, blocked = [] } = input as {
          service?: boolean;
          blocked?: string[];
        };
        if (service) await echo(call, "before the handoff");
        if (blocked.length > 0)
          ctx.deviceAccess.reportBlockedHosts(call, reported(blocked), {
            url: "https://example.org/",
          });
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
