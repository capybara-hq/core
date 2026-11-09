import { getSetupCheckStates, type SetupCheckSelection, type SetupGuideRef } from "../setup-guides";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * The cached states of a rendered guide's live checks (spec §10.3 `GET …/checks`): never runs a
 * check. Results move on their own (a run by someone else, the cache expiring), hence `live`.
 */
export const setupCheckStatesQuery = (orgId: string, ref: SetupGuideRef, s: SetupCheckSelection) =>
  defineQuery({
    key: keys.org(orgId).setupChecks(ref.itemId, ref.guideId, ref.version ?? "", {
      connectionId: s.connectionId ?? "",
      connectorId: s.connectorId ?? "",
      mode: s.mode ?? "",
      audience: s.audience ?? "",
    }),
    fn: ({ signal }) => getSetupCheckStates(orgId, ref, s, signal).then((r) => r.results),
    freshness: "live",
  });
