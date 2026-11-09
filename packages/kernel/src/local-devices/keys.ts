/**
 * Redis keys and bus topics of the connected-machine relay (environments spec §6, §13). Every key
 * is per device (or per request); writers set a TTL on each.
 */

/** The lease of the replica holding the machine's connection: `capk:device-lease:<deviceId>`. */
export const deviceLeaseKey = (deviceId: string): string => `capk:device-lease:${deviceId}`;

/** The list of requests waiting for the machine: `capk:device-req:<deviceId>`. */
export const deviceReqKey = (deviceId: string): string => `capk:device-req:${deviceId}`;

/** The result of one request: `capk:device-res:<requestId>`. */
export const deviceResKey = (requestId: string): string => `capk:device-res:${requestId}`;

/** The prefix of {@link deviceTakenKey} (the holder's Lua script builds the key from it). */
export const DEVICE_TAKEN_PREFIX = "capk:device-taken:";

/**
 * A request the holder forwarded to a machine: `capk:device-taken:<requestId>` → the device
 * id. Only a result for a taken request of the socket's own device is accepted.
 */
export const deviceTakenKey = (requestId: string): string => `${DEVICE_TAKEN_PREFIX}${requestId}`;

/** A new request for the machine of the device. */
export const deviceReqTopic = (deviceId: string): string => `device.req.${deviceId}`;

/** The result of one request is ready. */
export const deviceResTopic = (requestId: string): string => `device.res.${requestId}`;

/** Another replica took the machine's connection over. */
export const deviceTakeoverTopic = (deviceId: string): string => `device.takeover.${deviceId}`;

/** The machine's credential was revoked: its connection is closed. */
export const deviceRevokedTopic = (deviceId: string): string => `device.revoked.${deviceId}`;
