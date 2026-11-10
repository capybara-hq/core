"use client";

import {
  deleteAdminAgent,
  deleteAdminConnector,
  setAdminConnectorStatus,
  transferAdminAgent,
} from "../admin-items";
import { keys } from "./keys";
import { useAppMutation } from "./mutation";

// The super admin's writes on every org's agents and connectors (spec
// 2026-11-10-admin-agents-connectors §3.3, §3.5). Each invalidates the admin lists and the
// detail, and the org's own reads of the object (cached when the super admin is in that org too).

const d = () => keys.deployment();

type Done<R> = { onSuccess?: (r: R) => void };

/** 转移所有者: `POST /admin/agents/:id/owner` `{ accountId }`. */
export function useTransferAgent(o: Done<unknown> = {}) {
  return useAppMutation({
    fn: (v: { agentId: string; orgId: string; accountId: string }) =>
      transferAdminAgent(v.agentId, v.accountId),
    invalidates: (v) => [
      d().adminAgentsAll(),
      d().adminAgent(v.agentId),
      keys.org(v.orgId).agents(),
      keys.org(v.orgId).agent(v.agentId),
    ],
    ...(o.onSuccess !== undefined && { onSuccess: o.onSuccess }),
  });
}

/** 删除: `DELETE /admin/agents/:id`; the detail is forgotten when the page is left. */
export function useDeleteAgent(o: Done<unknown> = {}) {
  return useAppMutation({
    fn: (v: { agentId: string; orgId: string }) => deleteAdminAgent(v.agentId),
    invalidates: (v) => [d().adminAgentsAll(), keys.org(v.orgId).agents()],
    forgetsOnLeave: (v) => [d().adminAgent(v.agentId), keys.org(v.orgId).agent(v.agentId)],
    ...(o.onSuccess !== undefined && { onSuccess: o.onSuccess }),
  });
}

/** 停用 / 启用: `PATCH /admin/connectors/:id` `{ status }`. */
export function useSetConnectorStatus(o: Done<unknown> = {}) {
  return useAppMutation({
    fn: (v: { connectorId: string; orgId: string; status: "active" | "disabled" }) =>
      setAdminConnectorStatus(v.connectorId, v.status),
    invalidates: (v) => [
      d().adminConnectorsAll(),
      d().adminConnector(v.connectorId),
      keys.org(v.orgId).connectors(),
      keys.org(v.orgId).connector(v.connectorId),
    ],
    ...(o.onSuccess !== undefined && { onSuccess: o.onSuccess }),
  });
}

/** 删除: `DELETE /admin/connectors/:id`; the detail is forgotten when the page is left. */
export function useDeleteConnector(o: Done<unknown> = {}) {
  return useAppMutation({
    fn: (v: { connectorId: string; orgId: string }) => deleteAdminConnector(v.connectorId),
    invalidates: (v) => [d().adminConnectorsAll(), keys.org(v.orgId).connectors()],
    forgetsOnLeave: (v) => [
      d().adminConnector(v.connectorId),
      keys.org(v.orgId).connector(v.connectorId),
    ],
    ...(o.onSuccess !== undefined && { onSuccess: o.onSuccess }),
  });
}
