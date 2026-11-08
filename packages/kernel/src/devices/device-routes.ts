import { DEVICE_PROTOCOL_VERSION } from "@capybara-hq/plugin-sdk";
import websocket, { type WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { errorBody } from "../errors.js";
import type { MachineIdentity } from "./machines.js";

/** The device connection route (environments spec §13.4). */
export const DEVICE_CONNECT_ROUTE = "/device/connect";
/** The header carrying the program's protocol version. */
export const DEVICE_PROTOCOL_HEADER = "x-capybara-device-protocol";

/** What the route needs from the gateway (`DeviceGateway`). */
export interface DeviceRoutesGateway {
  authenticate(credential: string): Promise<MachineIdentity | null>;
  accept(socket: WebSocket, identity: MachineIdentity, credential: string): void;
}

export interface DeviceRoutesOptions {
  gateway: DeviceRoutesGateway;
  /** `environments.device.maxFrameBytes`: a larger incoming frame closes the socket (1009). */
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

/**
 * Registers `GET /device/connect` (the gateway role only) in its own encapsulated scope with
 * `@fastify/websocket`: a raw Fastify route outside Nest, so neither the API's `AuthGuard` nor its
 * CSRF check applies; the route checks the machine credential itself, before the upgrade (401
 * `device.credential_invalid`), then the protocol header (426 `environment.program_outdated`).
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
    const identities = new WeakMap<FastifyRequest, { identity: MachineIdentity; cred: string }>();
    scope.get(
      DEVICE_CONNECT_ROUTE,
      {
        websocket: true,
        preValidation: async (req, reply) => {
          const cred = bearer(req);
          const identity = cred === "" ? null : await opts.gateway.authenticate(cred);
          if (identity === null) {
            return reply
              .code(401)
              .send(
                errorBody(
                  "device.credential_invalid",
                  "The machine credential is unknown or revoked. Run capybara-device login again.",
                ),
              );
          }
          if (req.headers[DEVICE_PROTOCOL_HEADER] !== String(DEVICE_PROTOCOL_VERSION)) {
            return reply
              .code(426)
              .send(
                errorBody(
                  "environment.program_outdated",
                  `This kernel speaks device protocol ${DEVICE_PROTOCOL_VERSION}. ` +
                    "Update capybara-device.",
                ),
              );
          }
          identities.set(req, { identity, cred });
        },
      },
      (socket, req) => {
        const found = identities.get(req);
        if (!found) {
          socket.close(4400, "not authenticated");
          return;
        }
        opts.gateway.accept(socket, found.identity, found.cred);
      },
    );
  });
}
