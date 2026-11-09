import { getDevice, listDevices } from "../devices";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * The person's devices in the org (`{ items, defaultId, lastUsedId, cloudAvailable }`): the 设备
 * page, and the composer's picker and the properties panel read it too.
 */
export const devicesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).devices(),
    fn: () => listDevices(orgId),
    freshness: "live",
  });

/** One device (a 404 is the page's not-found). */
export const deviceQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).device(id),
    fn: () => getDevice(orgId, id),
    freshness: "live",
  });
