import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { ApiError, errorBody } from "../errors.js";
import type { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { type DeviceStreamViewers, HOP_AT_HEADER, HOP_HEADER, TICKET_ID_RE } from "./viewer.js";

/** The viewer route the panel opens (browser use spec §6.2). */
export const DEVICE_STREAM_ROUTE = "/device/stream";
/** The replica-to-replica hop to the gateway replica holding a local device's machine. */
export const DEVICE_STREAM_HOP_ROUTE = "/internal/device-stream/:ticketId";

/** What the viewer routes need ({@link DeviceStreamViewers}). */
export interface DeviceStreamRoutesOptions {
  viewers: Pick<DeviceStreamViewers, "serve" | "serveHop" | "verifyHop" | "claimHop">;
  /**
   * Counts each viewer upgrade per client address (`device-stream-ip`) before the upgrade; a
   * valid ticket gives the attempt back.
   */
  throttler: Pick<CredentialThrottler, "reserve" | "succeeded">;
}

/** The named throttler of the viewer route. */
const VIEWER_THROTTLER = ["device-stream-ip"] as const;

const hopRefused = () =>
  errorBody("device.stream_hop_refused", "This hop is not authenticated; it is refused.");

/**
 * Registers the viewer routes on `scope`, a Fastify scope where `@fastify/websocket` is
 * registered (the gateway role's device scope, `dial-in/routes.ts`): raw routes outside Nest, so
 * neither the API's `AuthGuard` nor its CSRF check applies; each route checks its own credential.
 *
 * - `GET /device/stream?ticket=`: the ticket is the only credential (cookies do not reach the
 *   gateway). Each upgrade counts against `device-stream-ip` (120 a minute per client address,
 *   `req.ip` under `http.trustProxy`: the web tier's upgrade proxy sets `X-Forwarded-For` for this
 *   path; 429 `rate_limited` before the upgrade; a valid ticket refunds it); otherwise the upgrade is accepted and the socket
 *   closed with the viewer close codes (`VIEWER_CLOSE`), since a browser sees no HTTP status of
 *   a refused upgrade.
 * - `GET /internal/device-stream/:ticketId`: another gateway replica's hop. Before the upgrade,
 *   and before anything else is read, the `X-Capybara-Hop` MAC and its issue time are checked
 *   (401 `device.stream_hop_refused` otherwise), then the hop is accepted once per ticket.
 *
 * The request log never carries the ticket: the access line drops the query and writes the hop
 * path as `/internal/device-stream/:ticket` (`redactPath`).
 */
export async function registerDeviceStreamRoutes(
  scope: FastifyInstance,
  opts: DeviceStreamRoutesOptions,
): Promise<void> {
  scope.get(
    DEVICE_STREAM_ROUTE,
    {
      websocket: true,
      preValidation: async (req, reply) => {
        try {
          await opts.throttler.reserve(VIEWER_THROTTLER, req, reply);
        } catch (e) {
          if (e instanceof ApiError && e.code === "rate_limited")
            return reply.code(429).send(errorBody(e.code, e.message));
          throw e;
        }
      },
    },
    (socket: WebSocket, req) => {
      const t = (req.query as Record<string, unknown> | undefined)?.ticket;
      void opts.viewers.serve(socket, typeof t === "string" ? t : "", () =>
        opts.throttler.succeeded(VIEWER_THROTTLER, req),
      );
    },
  );
  const verified = new WeakSet<object>();
  scope.get(
    DEVICE_STREAM_HOP_ROUTE,
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const ticketId = (req.params as { ticketId?: string }).ticketId ?? "";
        if (
          !opts.viewers.verifyHop(ticketId, req.headers[HOP_HEADER], req.headers[HOP_AT_HEADER]) ||
          !TICKET_ID_RE.test(ticketId) ||
          !(await opts.viewers.claimHop(ticketId))
        ) {
          return reply.code(401).send(hopRefused());
        }
        verified.add(req);
      },
    },
    (socket: WebSocket, req) => {
      if (!verified.has(req)) {
        socket.close(4401, "invalid hop");
        return;
      }
      const ticketId = (req.params as { ticketId: string }).ticketId;
      void opts.viewers.serveHop(socket, ticketId, String(req.headers[HOP_AT_HEADER]));
    },
  );
}
