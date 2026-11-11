import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { IanaTimeZone } from "../time-zone.js";

/** `GET /api/v1/admin/overview/usage`: the reader's zone; days are calendar days in it (spec §5.2). */
export const UsageQuery = z.object({
  tz: IanaTimeZone.describe(
    "The IANA time zone the days are counted in (the reader's zone), such as Asia/Shanghai.",
  ),
});

/** The admin overview's routes (admin overview spec §5.2): reads, only usage takes input. */
export const OVERVIEW_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/overview" },
  { route: "GET /api/v1/admin/overview/attention" },
  { route: "GET /api/v1/admin/overview/health" },
  { route: "GET /api/v1/admin/overview/usage", query: UsageQuery },
];
