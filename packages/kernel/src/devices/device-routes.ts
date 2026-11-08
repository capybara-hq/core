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
 * Must be called before Nest `app.init()`.
 */
export async function registerDeviceConnectRoute(
  fastify: FastifyInstance,
  opts: DeviceRoutesOptions,
): Promise<void> {
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
                  `This kernel speaks device protocol ${DEVICE_PROTOCOL_VERSION}. Update capybara-device.`,
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
