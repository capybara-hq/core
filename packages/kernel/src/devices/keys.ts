/**
 * Redis keys and bus topics of the connected-machine relay (environments spec §6, §13). Every key
 * is per environment (or per request); writers set a TTL on each.
 */

/** The lease of the replica holding the machine's connection: `capk:device-lease:<environmentId>`. */
export const deviceLeaseKey = (environmentId: string): string =>
  `capk:device-lease:${environmentId}`;

/** The list of requests waiting for the machine: `capk:device-req:<environmentId>`. */
export const deviceReqKey = (environmentId: string): string => `capk:device-req:${environmentId}`;

/** The result of one request: `capk:device-res:<requestId>`. */
export const deviceResKey = (requestId: string): string => `capk:device-res:${requestId}`;

/** A new request for the machine of the environment. */
export const deviceReqTopic = (environmentId: string): string => `device.req.${environmentId}`;

/** The result of one request is ready. */
export const deviceResTopic = (requestId: string): string => `device.res.${requestId}`;

/** Another replica took the machine's connection over. */
export const deviceTakeoverTopic = (environmentId: string): string =>
  `device.takeover.${environmentId}`;

/** The machine's credential was revoked: its connection is closed. */
export const deviceRevokedTopic = (environmentId: string): string =>
  `device.revoked.${environmentId}`;
