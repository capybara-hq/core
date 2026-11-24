import websocket, { type WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { errorBody } from "../errors.js";
import type { DialInAdmission } from "./gateway.js";

/** The device connection route (environments spec §13.4). */
export const DEVICE_CONNECT_ROUTE = "/device/connect";
/** The header carrying the dial-in protocol the program speaks (`<name>/<major>`). */
export const DEVICE_PROTOCOL_HEADER = "x-capybara-device-protocol";

/** What the route needs from the gateway (`DialInGateway`). */
export interface DeviceRoutesGateway {
  /** Who the credential stands for and the provider serving its device; null when unknown. */
  admit(credential: string): Promise<DialInAdmission>;
  /** Serves the upgraded socket (re-checks the credential with the socket paused). */
  accept(
    socket: WebSocket,
    credential: string,
    protocol: string,
    localPort?: number,
  ): Promise<void>;
}

export interface DeviceRoutesOptions {
  gateway: DeviceRoutesGateway;
  /** `devices.dialIn.maxFrameBytes`: a larger incoming frame closes the socket (1009). */
  maxFrameBytes: number;
}

/** The comma-separated tokens of a header, lowercased. */
function tokens(v: string | string[] | undefined): string[] {
  return [v ?? []]
    .flat()
    .flatMap((x) => x.split(","))
    .map((t) => t.trim().toLowerCase());
}

/**
 * A WebSocket upgrade: `Upgrade` lists `websocket` and `Connection` lists `upgrade` (both
 * case-insensitive). Other upgrades (`h2c`, …) are ordinary requests here.
 */
export function isWebSocketUpgrade(req: FastifyRequest): boolean {
  return viaUpgrade(req) && tokens(req.headers.upgrade).includes("websocket");
}

/**
 * A request Node handed to the server's `upgrade` listeners (`Connection: upgrade` and an
 * `Upgrade` header, any protocol): its socket belongs to no HTTP connection any more.
 */
function viaUpgrade(req: FastifyRequest): boolean {
  return req.headers.upgrade !== undefined && tokens(req.headers.connection).includes("upgrade");
}

/** The `Bearer` credential of the request, or "". */
function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m?.[1] ?? "";
}

/** A `<name>/<major>` protocol split in two; null for anything else. */
function protocolParts(v: string): { name: string; major: number } | null {
  const m = /^([a-z][a-z0-9-]{0,40})\/([1-9][0-9]{0,3})$/.exec(v);
  return m ? { name: m[1] as string, major: Number(m[2]) } : null;
}

/**
 * The text of a 426: the device's provider speaks `expected`, the program `spoken`. A program of
 * the same protocol family with a newer major is told the deployment is the one to upgrade; an
 * older one (or another protocol) to update the program. The program's protocol is named only
 * when it is a well-formed `<name>/<major>` (header input).
 */
export function protocolMismatchMessage(plugin: string, expected: string, spoken: unknown): string {
  const theirs = typeof spoken === "string" ? protocolParts(spoken) : null;
  const ours = protocolParts(expected);
  const said = theirs
    ? `this program speaks ${theirs.name}/${theirs.major}`
    : "this program speaks another protocol";
  const fix =
    theirs && ours && theirs.name === ours.name && theirs.major > ours.major
      ? "This deployment is older than the program; ask the platform's super admin to upgrade it, or install the program release that matches this deployment."
      : "Update the program on the machine to the release that speaks this protocol (for capybara-device: npm install -g @capybara-hq/device@next), then start it again.";
  return `This device is served by ${plugin}, which speaks ${expected}; ${said}. ${fix}`;
}

/**
 * Registers `GET /device/connect` (the gateway role only) in its own encapsulated scope with
 * `@fastify/websocket`: a raw Fastify route outside Nest, so neither the API's `AuthGuard` nor its
 * CSRF check applies. Before the upgrade the route checks the machine credential (401
 * `device.credential_invalid`), then the device's provider: off in the org, not loaded or not a
 * dial-in provider is 403 `device.provider_unavailable`; then the protocol header, which must
 * equal the provider's `permissions.dialIn.protocol` (426 `device.program_outdated`, naming the
 * provider's protocol).
 * Must be called before Nest `app.init()`, on the root instance.
 *
 * `@fastify/websocket` sends every upgrade request of the server through the Fastify router; the
 * root hooks below keep that from reaching any other route: a WebSocket upgrade to another path
 * is answered 404 and its socket closed once answered (Node would have dropped it without a
 * listener). Other upgrades (`h2c`) reach their route as ordinary requests; their socket, which
 * no HTTP connection owns any more, is closed once answered as well (the upgrade is declined).
 */
export async function registerDeviceConnectRoute(
  fastify: FastifyInstance,
  opts: DeviceRoutesOptions,
): Promise<void> {
  fastify.addHook("onRequest", async (req, reply) => {
    if (!isWebSocketUpgrade(req) || req.routeOptions.url === DEVICE_CONNECT_ROUTE) return;
    return reply
      .code(404)
      .send(errorBody("not_found", "This path does not accept a protocol upgrade"));
  });
  fastify.addHook("onResponse", async (req) => {
    if (viaUpgrade(req)) req.raw.socket?.destroy();
  });
  await fastify.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: opts.maxFrameBytes } });
    const admitted = new WeakMap<FastifyRequest, { credential: string; protocol: string }>();
    scope.get(
      DEVICE_CONNECT_ROUTE,
      {
        websocket: true,
        preValidation: async (req, reply) => {
          const cred = bearer(req);
          const admission = cred === "" ? null : await opts.gateway.admit(cred);
          if (admission === null) {
            return reply
              .code(401)
              .send(
                errorBody(
                  "device.credential_invalid",
                  "The machine credential is unknown or revoked. Run capybara-device logout, then capybara-device login.",
                ),
              );
          }
          if ("unavailable" in admission) {
            return reply
              .code(403)
              .send(
                errorBody(
                  "device.provider_unavailable",
                  admission.unavailable === "off"
                    ? "The provider serving this device is switched off in its organization; ask an organization admin to switch it on."
                    : "The provider serving this device cannot accept machine connections now; ask the platform's super admin to check it.",
                ),
              );
          }
          const { serving } = admission;
          const spoken = req.headers[DEVICE_PROTOCOL_HEADER];
          if (spoken !== serving.protocol) {
            return reply
              .code(426)
              .send(
                errorBody(
                  "device.program_outdated",
                  protocolMismatchMessage(serving.plugin, serving.protocol, spoken),
                ),
              );
          }
          admitted.set(req, { credential: cred, protocol: serving.protocol });
        },
      },
      (socket, req) => {
        const a = admitted.get(req);
        if (a === undefined) {
          socket.close(4400, "not authenticated");
          return;
        }
        void opts.gateway.accept(socket, a.credential, a.protocol, req.socket.localPort);
      },
    );
  });
}
