import {
  getDevice,
  listDeviceProjectCandidates,
  listDeviceProjects,
  listDevices,
} from "../devices";
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

/** A device's projects in its current mode (owner only; project root §4.1). */
export const deviceProjectsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).deviceProjects(id),
    fn: () => listDeviceProjects(orgId, id),
    freshness: "live",
  });

/** How long one scan stays fresh: longer than an add dialog stays open. */
const CANDIDATES_FRESH_MS = 10 * 60_000;

/**
 * A device's project suggestions (one `scan` of its base). Never prefetched: asking the device
 * starts or resumes it, so only the open add form reads it, and an open form scans once (no
 * refetch on window focus, reconnect or a "live" staleness window).
 */
export const deviceProjectCandidatesQuery = (orgId: string, id: string) => ({
  ...defineQuery({
    key: keys.org(orgId).deviceProjectCandidates(id),
    fn: () => listDeviceProjectCandidates(orgId, id),
    freshness: "live",
  }),
  staleTime: CANDIDATES_FRESH_MS,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});
