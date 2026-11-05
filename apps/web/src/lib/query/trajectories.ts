import {
  getTrajectory,
  listTrajectories,
  RUN_STATUSES,
  type RunStatus,
  TRAJECTORY_PAGE,
} from "../trajectories";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The trajectory list's filters (`?agentId=`, `?status=`; empty: any). */
export interface TrajectoryFilters {
  agentId: string;
  status: RunStatus | "";
}

/** The filters of the query's raw values (an unknown status is none). */
export const trajectoryFilters = (agentId: string, status: string): TrajectoryFilters => ({
  agentId,
  status: (RUN_STATUSES as readonly string[]).includes(status) ? (status as RunStatus) : "",
});

/**
 * A page of the trajectory list under `filters`: the first (`before` omitted) or the one after a
 * cursor. Each set of filters is its own cache entry, so one filter's rows never show under
 * another.
 */
export const trajectoriesQuery = (orgId: string, filters: TrajectoryFilters, before?: string) =>
  defineQuery({
    key: keys.org(orgId).trajectories(filters.agentId, filters.status, before),
    fn: () =>
      listTrajectories(orgId, {
        limit: TRAJECTORY_PAGE,
        ...(filters.agentId !== "" && { agentId: filters.agentId }),
        ...(filters.status !== "" && { status: filters.status }),
        ...(before !== undefined && { before }),
      }),
    freshness: "live",
  });

/** How many runs the trajectory page reads at a time (by run, never the whole conversation). */
export const TRAJECTORY_RUN_PAGE = 10;

/**
 * A conversation's trajectory: the latest {@link TRAJECTORY_RUN_PAGE} runs, or those before a
 * cursor (a 404 is the page's not-found: the kernel answers it to whoever may not see it). The
 * kernel writes a `trajectory.viewed` audit row per read.
 */
export const trajectoryQuery = (orgId: string, conversationId: string, before?: string) =>
  defineQuery({
    key: keys.org(orgId).trajectory(conversationId, before),
    fn: () =>
      getTrajectory(orgId, conversationId, {
        limit: TRAJECTORY_RUN_PAGE,
        ...(before !== undefined && { before }),
      }),
    freshness: "live",
  });
