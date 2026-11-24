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
   * valid ticket gives the attempt back. Absent when the client address is unknown
   * ({@link viewerThrottleOn}): no limit then.
   */
  throttler?: Pick<CredentialThrottler, "reserve" | "succeeded">;
}

/**
 * Whether the viewer limit applies (ruling R23): only when `http.trustProxy` trusts some hop, so
 * `req.ip` is the browser's address as the web tier forwards it. With nothing trusted, `req.ip` is
 * the web tier itself for every browser, and one bucket for all would let one client lock every
 * viewer out; the limit is defence in depth (a ticket is 192 random bits, used once), so it is
 * skipped rather than shared.
 */
export function viewerThrottleOn(trustProxy: boolean | number | string | string[]): boolean {
  if (trustProxy === false || trustProxy === 0 || trustProxy === "") return false;
  return !(Array.isArray(trustProxy) && trustProxy.length === 0);
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
 *   gateway). With `opts.throttler` (a trusted proxy configured), each upgrade counts against
 *   `device-stream-ip`: 120 a minute per client address, `req.ip` under `http.trustProxy` (the
 *   web tier's upgrade proxy sets `X-Forwarded-For` for this path); 429 `rate_limited` before
 *   the upgrade; a valid ticket refunds it. Otherwise the upgrade is accepted and the socket
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
        if (opts.throttler === undefined) return;
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
      const throttler = opts.throttler;
      void opts.viewers.serve(
        socket,
        typeof t === "string" ? t : "",
        throttler ? () => throttler.succeeded(VIEWER_THROTTLER, req) : undefined,
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
