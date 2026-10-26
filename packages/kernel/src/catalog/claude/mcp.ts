import {
  CATALOG_ITEM_NAME_RE,
  type ConnectorTemplateFile,
  PLUGIN_MANIFEST_LIMITS,
  parseConnectorTemplateFile,
} from "@capybara-hq/plugin-sdk";
import { credentialQueryParams } from "../../tools/endpoint.js";
import { cut, isObj, showName } from "./manifest.js";
import { item, type TranslationItem } from "./report.js";

/**
 * Claude Code MCP servers -> connector templates for `connector-mcp` (spec §8.3). Only remote
 * Streamable HTTP servers translate (`type` `http` / `streamable-http`, or a `url` without a type);
 * `sse`, `ws`, stdio and `.mcpb` / `.dxt` bundles are reported as unsupported transports. `${VAR}`
 * in headers become the auth fields an org fills at install; nothing secret is ever copied into a
 * template, and every generated file passes `parseConnectorTemplateFile`.
 */

/** The connector extension and kind the generated templates target. */
export const CLAUDE_MCP_CONNECTOR = { plugin: "connector-mcp", connector: "mcp" } as const;

/** Directory of the generated template files in the translated tree. */
export const GENERATED_CONNECTORS_DIR = ".capybara-generated/connectors";

/** Options of {@link mcpServerTemplates}. */
export interface McpTemplateOptions {
  /** Where each server was declared (path relative to the plugin root), for the report. */
  paths?: ReadonlyMap<string, string>;
  /** Accept `http://` loopback URLs (tests; `marketplaces.allowInsecureLoopback`). */
  allowInsecureLoopback?: boolean;
}

const VAR_RE = /\$\{([^}:]+)(?::-([^}]*))?\}/g;
const WHOLE_VAR_RE = /^\$\{([^}:]+)\}$/;
const BEARER_VAR_RE = /^Bearer \$\{([^}:]+)\}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `My Server` -> `my-server`; empty -> `mcp`; at most 64 characters, a valid template id. */
function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s === "" ? "mcp" : s;
}

const transportOf = (cfg: Record<string, unknown>): string | null => {
  const t = cfg.type;
  if (typeof t === "string") return t;
  if (typeof cfg.url === "string") return null;
  if (cfg.command !== undefined) return "stdio";
  return "unknown";
};

/**
 * Translates a merged map of Claude MCP servers (name -> config, later declarations already
 * applied) into connector template files keyed by template id, plus the report items. `plugin` is
 * the Claude plugin's name (used in the template description). At most
 * `PLUGIN_MANIFEST_LIMITS.connectorTemplates` templates; the rest are "too many servers".
 */
export function mcpServerTemplates(
  servers: ReadonlyMap<string, unknown> | Record<string, unknown>,
  plugin: string,
  opts: McpTemplateOptions = {},
): { files: Map<string, ConnectorTemplateFile>; items: TranslationItem[] } {
  const files = new Map<string, ConnectorTemplateFile>();
  const items: TranslationItem[] = [];
  const entries = servers instanceof Map ? [...servers] : Object.entries(servers);
  for (const [rawName, cfg] of entries) {
    const name = showName(rawName);
    const path = opts.paths?.get(rawName);
    const at = path !== undefined ? { path } : {};
    const invalid = (reason: string) =>
      items.push(item("mcp_invalid", "mcpServer", name, { ...at, detail: { reason } }));
    if (!isObj(cfg)) {
      invalid("the server configuration is not an object");
      continue;
    }
    const transport = transportOf(cfg);
    if (transport !== null && transport !== "http" && transport !== "streamable-http") {
      items.push(
        item("mcp_unsupported_transport", "mcpServer", name, {
          ...at,
          detail: { transport: showName(transport) },
        }),
      );
      continue;
    }
    if (typeof cfg.url !== "string" || cfg.url === "") {
      invalid("url must be a string");
      continue;
    }
    if (files.size >= PLUGIN_MANIFEST_LIMITS.connectorTemplates) {
      invalid("too many servers");
      continue;
    }
    const pending: TranslationItem[] = [];
    if (transport === null) pending.push(item("mcp_type_assumed", "mcpServer", name, at));

    // URL: ${VAR:-default} takes the default and makes url editable; a bare ${VAR} cannot be valid.
    let editable = false as boolean;
    let bare = undefined as string | undefined;
    const url = cfg.url.replace(VAR_RE, (_m, v: string, def: string | undefined) => {
      if (def === undefined) {
        bare ??= v;
        return "";
      }
      editable = true;
      pending.push(
        item("mcp_url_variable", "mcpServer", name, {
          ...at,
          detail: { variable: showName(v), default: showName(def) },
        }),
      );
      return def;
    });
    if (bare !== undefined) {
      items.push(
        item("mcp_url_variable", "mcpServer", name, {
          ...at,
          detail: { variable: showName(bare) },
        }),
      );
      continue;
    }
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = new URL(url);
    } catch {
      parsedUrl = undefined;
    }
    const urlOk =
      parsedUrl !== undefined &&
      (parsedUrl.protocol === "https:" ||
        (opts.allowInsecureLoopback === true &&
          parsedUrl.protocol === "http:" &&
          LOOPBACK.has(parsedUrl.hostname)));
    if (!urlOk) {
      invalid("url must be an https URL");
      continue;
    }
    // the endpoint is visible to every connector user: no credential may ride in the URL
    const u = parsedUrl as URL;
    if (u.username !== "" || u.password !== "") {
      invalid("the url must not contain a user name or password");
      continue;
    }
    const secretParams = credentialQueryParams(u);
    if (secretParams.length > 0) {
      invalid(
        `the url query parameter ${secretParams.map((k) => JSON.stringify(showName(k))).join(", ")} looks like a credential`,
      );
      continue;
    }

    // Headers: literal ones stay in the endpoint preset; ${VAR} ones become the auth fields.
    const literal: Record<string, string> = {};
    const vars: { header: string; variable: string; bearer: boolean }[] = [];
    let problem: string | undefined;
    if (cfg.headers !== undefined) {
      if (!isObj(cfg.headers)) problem = "headers must be an object";
      else {
        for (const [h, v] of Object.entries(cfg.headers)) {
          if (h === "__proto__") {
            problem = "the header name __proto__ is not allowed";
            break;
          }
          if (typeof v !== "string") {
            problem = `header ${showName(h)} must be a string`;
            break;
          }
          const bearer = BEARER_VAR_RE.exec(v);
          const whole = WHOLE_VAR_RE.exec(v);
          if (bearer && h.toLowerCase() === "authorization") {
            vars.push({ header: h, variable: bearer[1] as string, bearer: true });
          } else if (whole) {
            vars.push({ header: h, variable: whole[1] as string, bearer: false });
          } else if (v.includes("${")) {
            problem = `header ${showName(h)} mixes text and a variable`;
            break;
          } else literal[h] = v;
        }
      }
    }
    if (problem === undefined && cfg.headersHelper !== undefined) {
      problem = "headersHelper runs a command to produce headers";
    }
    const oauth = cfg.oauth !== undefined;
    if (problem === undefined && oauth && vars.length > 0) {
      problem = "the server declares both oauth and credential headers";
    }
    if (problem !== undefined) {
      invalid(problem);
      continue;
    }

    let auth: Record<string, unknown>;
    const first = vars[0];
    if (oauth) {
      auth = { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" };
    } else if (first === undefined) {
      auth = { type: "none" };
      pending.push(item("mcp_auth_none", "mcpServer", name, at));
    } else if (vars.length === 1 && first.bearer) {
      auth = { type: "bearer", ownership: "personal" };
    } else if (vars.length === 1) {
      auth = { type: "api_key", ownership: "personal", in: "header", name: first.header };
    } else {
      auth = { type: "headers", ownership: "personal", names: vars.map((v) => v.header) };
    }
    for (const v of vars) {
      pending.push(
        item("mcp_header_variable", "mcpServer", name, {
          ...at,
          detail: { header: showName(v.header), variable: showName(v.variable) },
        }),
      );
    }

    const file = {
      displayName: { zh: cut(name, 100), en: cut(name, 100) },
      description: cut(`Remote MCP server ${name} from Claude Code plugin ${plugin}`, 1024),
      template: {
        plugin: CLAUDE_MCP_CONNECTOR.plugin,
        connector: CLAUDE_MCP_CONNECTOR.connector,
        endpoint: { url, ...(Object.keys(literal).length > 0 && { headers: literal }) },
        ...(editable && { editableEndpoint: ["url"] }),
        auth,
      },
    };
    const parsed = parseConnectorTemplateFile(file);
    if ("errors" in parsed) {
      invalid(parsed.errors[0] ?? "the generated template is not valid");
      continue;
    }
    let id = slug(rawName);
    for (let n = 2; files.has(id); n++) id = `${slug(rawName).slice(0, 60)}-${n}`;
    if (!CATALOG_ITEM_NAME_RE.test(id)) {
      invalid("no valid template id");
      continue;
    }
    files.set(id, parsed);
    items.push(
      item("mcp_template", "mcpServer", name, {
        path: `${GENERATED_CONNECTORS_DIR}/${id}.json`,
        detail: { template: id, auth: String(auth.type) },
      }),
      ...pending,
    );
  }
  return { files, items };
}
