import type { ConnectorAuth } from "../tools/credentials.js";
import type { PersonFieldSpec } from "./person-fields.js";

/**
 * The person fields of a connector (platform web parity ruling R3). Credentials are not in a
 * connector's `endpointSchema` (`endpointCredentialIssues` refuses them there), so the secret
 * fields come from the auth method (`tools/credentials.ts`), by the paths of the create body:
 * - `bearer` / `api_key`: `credential.token`;
 * - `basic`: `credential.username`, `credential.password`;
 * - `oauth_client`, `oauth_code` with a manual client: `client.clientSecret` (the client id stays
 *   a param; required for the client credentials flow, optional for a public code client).
 *
 * `none`, a dynamically registered client and custom `headers` have none: header names come from
 * the auth preset (text an admin or the model wrote), never a card label, so header credentials
 * are entered on the web. Labels are fixed English; every schema is a non-empty string.
 */
export function connectorPersonFields(
  auth: ConnectorAuth,
  stored: ReadonlySet<string>,
): PersonFieldSpec[] {
  const field = (
    path: string,
    label: string,
    required: boolean,
    maxLength?: number,
  ): PersonFieldSpec => ({
    path,
    label,
    multiline: false,
    required,
    isSet: stored.has(path),
    schema: { type: "string", minLength: 1, ...(maxLength !== undefined && { maxLength }) },
  });
  switch (auth.type) {
    case "bearer":
    case "api_key":
      return [field("credential.token", "Token", true)];
    case "basic":
      return [
        field("credential.username", "Username", true),
        field("credential.password", "Password", true),
      ];
    case "oauth_client":
      // the bound of the create's OAuth client parse (`OAuthClientCredential`)
      return [field("client.clientSecret", "Client secret", true, 4000)];
    case "oauth_code":
      return auth.client === "manual"
        ? [field("client.clientSecret", "Client secret", false, 4000)]
        : [];
    default:
      return [];
  }
}

/**
 * The credential value the create, credential and install bodies take, from the person's entered
 * values (by the paths of {@link connectorPersonFields}, under `prefix`) and the model's client
 * id: `{ token }`, `{ username, password }`, or the OAuth client `{ clientId, clientSecret? }`.
 * Undefined when nothing was entered and no client given (the body then carries none).
 */
export function connectorCredential(
  auth: ConnectorAuth,
  entered: Readonly<Record<string, string>>,
  clientId: string | undefined,
  prefix = "",
): Record<string, string> | undefined {
  const at = (p: string) => entered[`${prefix}${p}`];
  if (auth.type === "oauth_client" || auth.type === "oauth_code") {
    if (clientId === undefined) return undefined;
    const secret = at("client.clientSecret");
    return { clientId, ...(secret !== undefined && { clientSecret: secret }) };
  }
  if (auth.type === "bearer" || auth.type === "api_key") {
    const token = at("credential.token");
    return token === undefined ? undefined : { token };
  }
  if (auth.type === "basic") {
    const username = at("credential.username");
    const password = at("credential.password");
    if (username === undefined && password === undefined) return undefined;
    return {
      ...(username !== undefined && { username }),
      ...(password !== undefined && { password }),
    };
  }
  return undefined;
}

/** A connector template whose connector a write creates: its id, card name and auth method. */
export interface TemplateTarget {
  id: string;
  /** The template's display name (from the plugin), for the card labels. */
  name: string;
  auth: ConnectorAuth;
}

/**
 * The person fields of connectors made from templates (the catalog install, the missing
 * connectors of an installed plugin): each template's {@link connectorPersonFields} under
 * `connectors.<templateId>.`, labelled `<template name>: <label>`.
 */
export function templatePersonFields(templates: readonly TemplateTarget[]): PersonFieldSpec[] {
  return templates.flatMap((t) =>
    connectorPersonFields(t.auth, new Set()).map((f) => ({
      ...f,
      path: `connectors.${t.id}.${f.path}`,
      label: `${t.name}: ${f.label}`,
    })),
  );
}

/** The model's non-secret input of one template's connector (a Platform operation param). */
export interface TemplateParams {
  name?: string | undefined;
  slug?: string | undefined;
  endpoint?: Record<string, unknown> | undefined;
  client?: { clientId: string } | undefined;
}

/**
 * One template's connector input as the install and configure bodies take it
 * (`CatalogConnectorInput`): the model's params with the person's entered values (under
 * `connectors.<templateId>.`) as `credential` or the OAuth client's `clientSecret`.
 */
export function templateConnectorInput(
  t: TemplateTarget,
  params: TemplateParams | undefined,
  entered: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const { client, ...rest } = params ?? {};
  const value = connectorCredential(t.auth, entered, client?.clientId, `connectors.${t.id}.`);
  const oauth = t.auth.type === "oauth_client" || t.auth.type === "oauth_code";
  return {
    ...rest,
    ...(value !== undefined && (oauth ? { client: value } : { credential: value })),
  };
}

/**
 * Why a write cannot ask the person for a connector's credential on the card, or null: custom
 * header credentials (their names come from the auth preset) are entered on the web.
 */
export function headersWebOnly(auth: ConnectorAuth, where: string): string | null {
  return auth.type === "headers"
    ? `${where} authenticates with custom headers, whose values the confirmation card cannot ask for; the person enters them on the web.`
    : null;
}

/**
 * Why a write's OAuth client param does not fit the auth method, or null: an OAuth client the
 * person enters a secret for (oauth_client, oauth_code with a manual client) needs its id in
 * `client`; any other auth method takes no client (refused rather than ignored).
 */
export function clientProblem(
  auth: ConnectorAuth,
  client: { clientId: string } | undefined,
  where: string,
): string | null {
  const needs =
    auth.type === "oauth_client" || (auth.type === "oauth_code" && auth.client === "manual");
  if (needs && client === undefined) {
    return `${where} uses an OAuth client: pass its id in client (the person enters the client secret on the confirmation card)`;
  }
  if (!needs && client !== undefined) {
    return `${where} takes no OAuth client (auth ${auth.type}${auth.type === "oauth_code" ? " with a registered client" : ""}); leave client out`;
  }
  return null;
}
