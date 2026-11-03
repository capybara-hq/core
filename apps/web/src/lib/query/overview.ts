import type { UseQueryOptions } from "@tanstack/react-query";
import type { ApiClientError } from "../api";
import { agentsQuery } from "./agents";
import { connectorsQuery, modelsQuery } from "./conversation";
import { inboxQuery } from "./inbox";
import { membersQuery } from "./members";
import { conversationGroupsQuery } from "./shell";
import { skillsQuery } from "./skills";

const any = <T>(o: UseQueryOptions<T, ApiClientError>) =>
  o as unknown as UseQueryOptions<unknown, ApiClientError>;

/**
 * The overview's reads (`/`): the agents and the models (required); the inbox and the sidebar's
 * conversation groups (sections: the conversations to pick up are their newest rows, so the page
 * shares the sidebar's read); the skills, connectors and members (their counts, when the role may
 * read them).
 */
export const overviewQueries = (orgId: string): UseQueryOptions<unknown, ApiClientError>[] => [
  any(agentsQuery(orgId)),
  any(modelsQuery(orgId)),
  any(inboxQuery(orgId)),
  any(conversationGroupsQuery(orgId)),
  any(skillsQuery(orgId)),
  any(connectorsQuery(orgId)),
  any(membersQuery(orgId)),
];
