import "server-only";
import { cache } from "react";
import { getTrajectory } from "../trajectories";

/** How many runs the trajectory page reads at a time (by run, never the whole conversation). */
export const TRAJECTORY_RUN_PAGE = 10;

/**
 * The trajectory page's first read: the latest {@link TRAJECTORY_RUN_PAGE} runs. The kernel writes
 * a `trajectory.viewed` audit row per read, so it is read once per request (React.cache), whoever
 * asks for it.
 */
export const firstTrajectoryPage = cache((orgId: string, conversationId: string) =>
  getTrajectory(orgId, conversationId, { limit: TRAJECTORY_RUN_PAGE }),
);
