// Org agent templates (plugin scope phase 4, spec §15, rulings P4-9 to P4-13): 另存为模板 writes
// an org row (`agent_templates`, no plugin, a bare `<name>`, version 1) from an agent, the template
// detail reads any template usable in the org, and the owner org's admins write new versions.
// Deleting and 可共享 are `OwnedItems`' (the P3 owner rules). No in-process state.
import {
  AGENT_TEMPLATE_LIMITS,
  type AgentTemplate,
  type AgentTemplateConnector,
  type AgentTemplateInlineSubagent,
  extensionToolKey,
  parseAgentTemplate,
  parseToolKey,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type Owner, ownerOf, ownersOf } from "../catalog/ownership.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { notifySharedUpdate } from "../inbox/org-notices.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock } from "../orgs/org-lock.js";
import { skillVersionsById } from "../skills/usable.js";
import { canonicalJson } from "../tools/canonical-json.js";
import { AgentLookup, type AgentView } from "./agent-lookup.js";
import {
  type AgentTemplateView,
  loadTemplates,
  putTemplateVersionIn,
  type TemplateRow,
  templateTypeOf,
  templateViewOf,
  usableTemplates,
} from "./templates.js";

/** A template with its definition, as `GET orgs/:orgId/agent-templates/:id` answers. */
export interface AgentTemplateDetail extends AgentTemplateView {
  /** The current definition (the served version). */
  definition: AgentTemplate;
  /** Who owns it: the platform, or the org that created it (P3-14's shape). */
  owner: Owner;
  /**
   * The org's own template (an org template, promoted or not; rulings P3-6, P4-12): its admins
   * edit, delete and set 可共享 on it. Always false for a plugin's template.
   */
  owned: boolean;
  /** 可共享 (only meaningful when `owned`). */
  shareable: boolean;
  /** Shared already: the platform row it was promoted to on share (ruling P3-3). */
  promoted: boolean;
}

/**
 * What 另存为模板 left out (ruling P4-10), listed to the person: `kind` names the part of the
 * agent, `name` the item (roster name, skill or connector name), `id` its id when it has one, and
 * `reason`:
 * - `org_agent`: an allowlisted org agent in the roster (an agent, not a template);
 * - `unavailable`: a skill, sub-agent template or connector the org can no longer use;
 * - `agent_skill`: one of the agent's own skills (not in the org library, so no other agent could
 *   resolve it);
 * - `no_endpoint`: a hand-configured connector without a URL to record (an inline OpenAPI document);
 * - `unsupported_protocol`: a hand-configured connector of a kind other than MCP or OpenAPI;
 * - `limit`: past a template limit (connectors 16, sub-agent types and inline 16, tools 200).
 */
export interface SaveAsOmission {
  kind: "subagent_agent" | "subagent_template" | "subagent_inline" | "skill" | "connector" | "tool";
  name: string;
  id?: string;
  reason:
    | "org_agent"
    | "unavailable"
    | "agent_skill"
    | "no_endpoint"
    | "unsupported_protocol"
    | "limit";
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
const TOOL_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const notFound = () => new ApiError("component.not_found", "Agent template not found");
const agentNotFound = () => new ApiError("agent.not_found", "Agent not found");

/**
 * A connector's URL as a template may record it (ruling P4-11): userinfo, query and fragment
 * removed (they may carry credentials). Null when it is no absolute http(s) URL.
 */
export function sanitizeEndpoint(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  const out = u.toString();
  return out.length <= 2048 ? out : null;
}

/** The URL a hand-configured connector's endpoint names: MCP `url`, OpenAPI `specUrl` / `baseUrl`. */
function endpointUrl(endpoint: unknown): string | null {
  if (endpoint === null || typeof endpoint !== "object" || Array.isArray(endpoint)) return null;
  const e = endpoint as Record<string, unknown>;
  for (const k of ["url", "specUrl", "baseUrl"]) {
    if (typeof e[k] === "string") return sanitizeEndpoint(e[k]);
  }
  return null;
}

/**
 * Validates a template definition the way an `agents/<name>.md` file is (the SDK parser, so the
 * two never drift): the definition minus `instructions` as the frontmatter (JSON is YAML), then
 * the instructions as the body. Problems -> 400 `validation_failed` naming each.
 */
export function parseTemplateDefinition(definition: Record<string, unknown>): AgentTemplate {
  const { instructions, ...front } = definition;
  if (typeof instructions !== "string") {
    throw new ApiError("validation_failed", "Invalid agent template: instructions is required", [
      { path: "definition.instructions", message: "instructions must be a string" },
    ]);
  }
  const parsed = parseAgentTemplate(`---\n${JSON.stringify(front)}\n---\n${instructions}`);
  if ("errors" in parsed) {
    throw new ApiError(
      "validation_failed",
      `Invalid agent template: ${parsed.errors[0] ?? "unknown problem"}`,
      parsed.errors.map((message) => ({ path: "definition", message })),
    );
  }
  return parsed.template;
}

/**
 * The template an agent is saved as (rulings P4-10, P4-11), with what was left out. Pure reads of
 * the org's state through `db`.
 */
export async function templateFromAgent(
  db: KernelSchemaDb,
  orgId: string,
  agent: AgentView,
  meta: { name: string; description: string },
): Promise<{ template: AgentTemplate; omitted: SaveAsOmission[] }> {
  const def = agent.definition;
  const omitted: SaveAsOmission[] = [];
  const L = AGENT_TEMPLATE_LIMITS;

  // Tools: builtin and plugin tool keys; connector tools become `connectors` entries
  const tools: string[] = [];
  const connectorRefs: { connectorId: string; tools: "all" | string[] }[] = [];
  // stored definitions are not parsed: fields with schema defaults may be missing
  for (const r of def.tools ?? []) {
    if (r.kind === "connector") {
      connectorRefs.push({ connectorId: r.connectorId, tools: r.tools });
      continue;
    }
    const key = r.kind === "builtin" ? r.name : extensionToolKey(r.plugin, r.name);
    if (!TOOL_KEY_RE.test(key) || tools.includes(key)) continue;
    if (tools.length >= L.tools) {
      omitted.push({ kind: "tool", name: key, reason: "limit" });
      continue;
    }
    tools.push(key);
  }
  const toolPolicies = Object.fromEntries(
    Object.entries(def.toolPolicies ?? {}).filter(([k]) => tools.includes(k)),
  );

  // Skills: ids -> names (pinned -> `skills`, the other selected ones -> `selectedSkills`)
  const pinned = def.skills?.pinned ?? [];
  const selected = def.skills?.orgSkills ?? [];
  const inlineSkillIds = (def.subagents?.inline ?? []).flatMap((t) => t.skills ?? []);
  const byId = await skillVersionsById(db, orgId, [...pinned, ...selected, ...inlineSkillIds]);
  const agentSkillNames = new Map(
    (
      await db
        .selectFrom("skills")
        .select(["id", "name"])
        .where("org_id", "=", orgId)
        .where("scope", "=", "agent")
        .where("id", "in", ["", ...pinned, ...selected, ...inlineSkillIds])
        .execute()
    ).map((r) => [r.id, r.name]),
  );
  const skillName = (id: string, report: boolean): string | null => {
    const s = byId.get(id);
    if (s && s.scope === "org") return s.name;
    if (report) {
      const own = agentSkillNames.get(id) ?? s?.name;
      omitted.push(
        own !== undefined
          ? { kind: "skill", name: own, id, reason: "agent_skill" }
          : { kind: "skill", name: id, id, reason: "unavailable" },
      );
    }
    return null;
  };
  const skills: string[] = [];
  for (const id of pinned) {
    const n = skillName(id, true);
    if (n !== null && !skills.includes(n) && skills.length < L.skills) skills.push(n);
  }
  const selectedSkills: string[] = [];
  for (const id of selected) {
    if (pinned.includes(id)) continue;
    const n = skillName(id, true);
    if (n === null || skills.includes(n) || selectedSkills.includes(n)) continue;
    if (selectedSkills.length >= L.selectedSkills) {
      omitted.push({ kind: "skill", name: n, id, reason: "limit" });
      continue;
    }
    selectedSkills.push(n);
  }

  // Connectors (P4-11), then the agent's pending connectors as they are
  const connectors: AgentTemplateConnector[] = [];
  const pushConnector = (c: AgentTemplateConnector, name: string, id?: string) => {
    if (connectors.length >= L.connectors) {
      omitted.push({ kind: "connector", name, ...(id !== undefined && { id }), reason: "limit" });
    } else connectors.push(c);
  };
  const ids = [...new Set(connectorRefs.map((r) => r.connectorId))];
  const rows =
    ids.length === 0
      ? []
      : await db
          .selectFrom("connectors as c")
          .leftJoin("platform_connector_templates as p", (j) =>
            j.onRef("p.id", "=", "c.platform_template_id").on("p.deleted_at", "is", null),
          )
          .select(["c.id", "c.name", "c.connector", "c.endpoint", "p.id as template_id"])
          .where("c.org_id", "=", orgId)
          .where("c.deleted_at", "is", null)
          .where("c.id", "in", ids)
          .execute();
  const connectorById = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const c = connectorById.get(id);
    if (!c) {
      omitted.push({ kind: "connector", name: id, id, reason: "unavailable" });
      continue;
    }
    const refs = connectorRefs.filter((r) => r.connectorId === id);
    const named = refs.some((r) => r.tools === "all")
      ? null
      : [...new Set(refs.flatMap((r) => r.tools as string[]))].slice(0, L.connectorTools);
    if (c.template_id !== null) {
      pushConnector(
        { template: c.template_id, ...(named !== null && { tools: named }) },
        c.name,
        c.id,
      );
      continue;
    }
    if (c.connector !== "mcp" && c.connector !== "openapi") {
      omitted.push({ kind: "connector", name: c.name, id: c.id, reason: "unsupported_protocol" });
      continue;
    }
    const endpoint = endpointUrl(c.endpoint);
    if (endpoint === null) {
      omitted.push({ kind: "connector", name: c.name, id: c.id, reason: "no_endpoint" });
      continue;
    }
    const enabled =
      named ??
      (
        await db
          .selectFrom("connector_tools")
          .select("name")
          .where("connector_id", "=", c.id)
          .where("status", "=", "enabled")
          .orderBy("name")
          .execute()
      )
        .map((t) => t.name)
        .slice(0, L.connectorTools);
    pushConnector(
      {
        needs: {
          protocol: c.connector,
          endpoint,
          tools: enabled.filter((t) => t.length <= 128),
          label: [...c.name].slice(0, 80).join(""),
        },
      },
      c.name,
      c.id,
    );
  }
  const pending = (def as { pendingConnectors?: unknown }).pendingConnectors;
  for (const p of Array.isArray(pending) ? pending : []) {
    const e = p as {
      label?: string;
      source?: { template?: string; needs?: AgentTemplateConnector & object };
      tools?: string[];
    };
    const label = typeof e.label === "string" ? e.label : "";
    if (typeof e.source?.template === "string") {
      pushConnector(
        { template: e.source.template, ...(Array.isArray(e.tools) && { tools: e.tools }) },
        label,
      );
    } else if (e.source?.needs !== undefined) {
      const n = e.source.needs as unknown as {
        protocol: "mcp" | "openapi";
        endpoint: string;
        tools: string[];
        label: string;
      };
      const endpoint = sanitizeEndpoint(n.endpoint);
      if (endpoint === null) {
        omitted.push({ kind: "connector", name: label, reason: "no_endpoint" });
        continue;
      }
      pushConnector({ needs: { ...n, endpoint } }, label);
    }
  }

  // Sub-agents: template ids -> types, inline skill ids -> names; org agents are left out
  const sub = def.subagents;
  let subagents: AgentTemplate["subagents"];
  if (sub !== undefined) {
    const types: string[] = [];
    const inline: AgentTemplateInlineSubagent[] = [];
    const room = () => types.length + inline.length < L.subagentTypes;
    const found = await loadTemplates(db, orgId, sub.templates ?? []);
    for (const id of sub.templates ?? []) {
      const t = found.get(id);
      if (!t) {
        omitted.push({ kind: "subagent_template", name: id, id, reason: "unavailable" });
        continue;
      }
      const type = templateTypeOf(t.plugin, t.name);
      if (types.includes(type)) continue;
      if (!room()) {
        omitted.push({ kind: "subagent_template", name: type, id, reason: "limit" });
        continue;
      }
      types.push(type);
    }
    for (const t of sub.inline ?? []) {
      if (!room()) {
        omitted.push({ kind: "subagent_inline", name: t.name, reason: "limit" });
        continue;
      }
      const ownTools = (t.tools ?? tools).filter(
        (k) => TOOL_KEY_RE.test(k) && parseToolKey(k)?.kind !== "connector",
      );
      const inlineSkills: string[] = [];
      for (const id of t.skills ?? []) {
        const n = skillName(id, false);
        if (n !== null && !inlineSkills.includes(n)) inlineSkills.push(n);
      }
      inline.push({
        name: t.name,
        description: t.description,
        instructions: t.instructions,
        tools: [...new Set(ownTools)].slice(0, L.tools),
        skills: inlineSkills.slice(0, L.skills),
        model: t.model ?? "inherit",
      });
    }
    for (const a of sub.agents ?? []) {
      omitted.push({ kind: "subagent_agent", name: a.as, id: a.agentId, reason: "org_agent" });
    }
    subagents = {
      ...(sub.general !== undefined && { general: sub.general }),
      ...(types.length > 0 && { types }),
      ...(inline.length > 0 && { inline }),
    };
  }

  const effort = def.modelParams?.effort;
  const template: AgentTemplate = {
    name: meta.name,
    description: meta.description,
    instructions: def.instructions ?? "",
    tools,
    ...(Object.keys(toolPolicies).length > 0 && { toolPolicies }),
    model: "standard",
    modelRef: `${def.model.provider}/${def.model.model}`,
    ...(typeof effort === "string" && EFFORTS.includes(effort as Effort)
      ? { effort: effort as Effort }
      : {}),
    ...(skills.length > 0 && { skills }),
    ...(selectedSkills.length > 0 && { selectedSkills }),
    ...(connectors.length > 0 && { connectors }),
    ...(subagents !== undefined && { subagents }),
    ...(agent.profile.quickActions.length > 0 && {
      quickActions: agent.profile.quickActions.map((q) => ({ title: q.title, body: q.body })),
    }),
    ...(def.instructionFiles !== undefined && {
      instructionFiles: def.instructionFiles.map((f) => ({ name: f.name, content: f.content })),
    }),
  };
  // the same rules as a template file: a template that would not load is never written
  return {
    template: parseTemplateDefinition(template as unknown as Record<string, unknown>),
    omitted,
  };
}

/** The org's own template row (an org template: no plugin, no catalog item), with its link. */
interface OwnTemplateRow {
  id: string;
  name: string;
  current_version: number;
  shareable: boolean;
  /** The platform row it was promoted to (ruling P3-3), or null. */
  link: string | null;
}

/**
 * The org's agent templates beyond the plugin ones (rulings P4-9 to P4-12): 另存为模板, the detail
 * of a usable template and the owner's new versions. Writes run under the org row lock, with
 * `agents.manage` re-checked there.
 */
@Injectable()
export class OrgAgentTemplates {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
    @Inject(AgentLookup) private readonly agents: Pick<AgentLookup, "view">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * 另存为模板 (ruling P4-9): the org's live agent `agentId` (any one: an org admin may edit every
   * agent of the org) saved as the org template `name` (version 1, `plugin_name` null), mapped
   * by {@link templateFromAgent}. The bare name must be free in the org (rule 10): a usable
   * template of that type, one of the org's own rows of that name, or a live platform template
   * the org created under that name -> 409 `agent_template.name_taken` naming its owner (details
   * `[{ owner, templateId }]`). Audits `agent_template.created`.
   */
  @Transactional()
  async saveAs(
    orgId: string,
    actor: string,
    agentId: string,
    meta: { name: string; description: string },
    actorTokenId?: string,
  ): Promise<{ template: AgentTemplateDetail; omitted: SaveAsOmission[] }> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actor, "agents.manage");
    const live = await t
      .selectFrom("agents")
      .select("id")
      .where("id", "=", agentId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) throw agentNotFound();
    const agent = await this.agents.view(agentId);
    await this.assertNameFree(orgId, meta.name);
    const { template, omitted } = await templateFromAgent(t, orgId, agent, meta);
    const put = await putTemplateVersionIn(
      t,
      { orgId, plugin: null, catalogItemId: null, catalogVersion: null, sourceFormat: "capybara" },
      template,
    );
    await audit(t, {
      actorAccountId: actor,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent_template.created",
      target: put.id,
      detail: { name: template.name, fromAgent: agentId, omitted: omitted.length },
    });
    return { template: await this.detail(orgId, put.id), omitted };
  }

  /**
   * Rule 10 for a new org template named `name` (a bare type): refused while the org's usable set
   * has that type, the org has a live row of that name without a plugin (an unusable copy too:
   * the live-name index), or the platform has a live template the org created under that name
   * (promotion would clash).
   */
  private async assertNameFree(orgId: string, name: string): Promise<void> {
    const t = this.db;
    const clash = (owner: Owner, templateId: string): never => {
      throw new ApiError(
        "agent_template.name_taken",
        owner.kind === "platform"
          ? `An agent template named ${name} is already used in this organization (the platform's)`
          : owner.orgId === orgId
            ? `An agent template named ${name} already exists in this organization`
            : `An agent template named ${name} is already used in this organization (from organization ${owner.name})`,
        [{ owner, templateId }],
      );
    };
    const own = await t
      .selectFrom("agent_templates")
      .select("id")
      .where("org_id", "=", orgId)
      .where("plugin_name", "is", null)
      .where("name", "=", name)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const self = ownerOf(orgId, await ownersOf(t, [orgId]));
    if (own) clash(self, own.id);
    const usable = (await usableTemplates(t, orgId)).find(
      (u) => templateTypeOf(u.plugin, u.name) === name,
    );
    if (usable) clash(await this.ownerOfRow(orgId, usable), usable.id);
    const origin = await t
      .selectFrom("platform_agent_templates")
      .select(["id", "owner_org_id"])
      .where("origin_org_id", "=", orgId)
      .where("plugin_name", "is", null)
      .where("name", "=", name)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (origin) {
      const ids = origin.owner_org_id === null ? [] : [origin.owner_org_id];
      clash(ownerOf(origin.owner_org_id, await ownersOf(t, ids)), origin.id);
    }
  }

  /**
   * A template usable in the org by id ({@link loadTemplates}: an org row, a linked copy, a
   * platform template on in the org) with its definition, owner and the org's flags. Not usable
   * -> 404 `component.not_found`.
   */
  async detail(orgId: string, id: string): Promise<AgentTemplateDetail> {
    const t = (await loadTemplates(this.db, orgId, [id])).get(id);
    if (!t) throw notFound();
    const own = await this.ownRow(orgId, id, false);
    let linked: string[] = [];
    if (t.origin === "platform" && !t.ownedCopy && t.id === t.platformTemplateId) {
      linked = (
        await this.db
          .selectFrom("agent_templates")
          .select("id")
          .where("org_id", "=", orgId)
          .where("deleted_at", "is", null)
          .where("pinned_version", "is", null)
          .where("platform_template_id", "=", t.id)
          .orderBy("id")
          .execute()
      ).map((r) => r.id);
    }
    return {
      ...templateViewOf(t, linked),
      definition: t.template,
      owner: own
        ? ownerOf(orgId, await ownersOf(this.db, [orgId]))
        : await this.ownerOfRow(orgId, t),
      owned: own !== undefined,
      shareable: own?.shareable ?? false,
      promoted: own !== undefined && own.link !== null,
    };
  }

  /**
   * A new version of the org's own template `id` (ruling P4-12; `agents.manage` re-checked under
   * the org row lock): `definition` is validated like a template file and keeps its name;
   * `expectedVersion` must be the version the editor read (else 409
   * `agent_template.version_conflict`). An unshared template gets a new version of its org row; a
   * promoted one a new version of its platform row (ruling P3-4), which the org row then serves
   * (ruling P3-43), and the orgs using it are told (`shared_item_updated`). An unchanged
   * definition writes nothing. Not the org's own -> 409 `catalog.not_owned`; missing -> 404.
   * Agents created earlier are never touched. Audits `agent_template.updated`.
   */
  @Transactional()
  async update(
    orgId: string,
    actor: string,
    id: string,
    body: { definition: Record<string, unknown>; expectedVersion: number },
    actorTokenId?: string,
  ): Promise<AgentTemplateDetail> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actor, "agents.manage");
    const row = await this.ownRow(orgId, id, true);
    if (!row) throw await this.notOwnedOrMissing(orgId, id);
    const template = parseTemplateDefinition(body.definition);
    if (template.name !== row.name) {
      throw new ApiError("validation_failed", "The name of an agent template cannot change", [
        { path: "definition.name", message: `must stay ${row.name}` },
      ]);
    }
    const conflict = (now: number) =>
      new ApiError(
        "agent_template.version_conflict",
        `The agent template was changed by someone else (now version ${now}, expected ${body.expectedVersion}); reload it and apply your changes again`,
      );
    if (row.link === null) {
      if (row.current_version !== body.expectedVersion) throw conflict(row.current_version);
      const put = await putTemplateVersionIn(
        t,
        {
          orgId,
          plugin: null,
          catalogItemId: null,
          catalogVersion: null,
          sourceFormat: "capybara",
        },
        template,
      );
      if (put.changed) {
        await audit(t, {
          actorAccountId: actor,
          ...(actorTokenId !== undefined && { actorTokenId }),
          orgId,
          action: "agent_template.updated",
          target: id,
          detail: { name: row.name, from: row.current_version, to: put.version },
        });
      }
      return this.detail(orgId, id);
    }
    const p = await t
      .selectFrom("platform_agent_templates as p")
      .innerJoin("platform_agent_template_versions as v", (j) =>
        j.onRef("v.template_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
      )
      .select(["p.current_version", "v.definition", "v.source_format"])
      .where("p.id", "=", row.link)
      .where("p.deleted_at", "is", null)
      .forUpdate("p")
      .executeTakeFirst();
    if (!p) throw notFound();
    if (p.current_version !== body.expectedVersion) throw conflict(p.current_version);
    if (canonicalJson(p.definition) === canonicalJson(template)) return this.detail(orgId, id);
    const to = p.current_version + 1;
    await t
      .updateTable("platform_agent_templates")
      .set({ current_version: to, description: template.description, updated_at: new Date() })
      .where("id", "=", row.link)
      .execute();
    await t
      .insertInto("platform_agent_template_versions")
      .values({
        template_id: row.link,
        version: to,
        definition: JSON.stringify(template),
        // an org template has no file: only its parsed definition is stored
        object_prefix: null,
        catalog_version: null,
        source_format: p.source_format,
        created_by: actor,
      })
      .execute();
    await notifySharedUpdate(
      t,
      { kind: "agent_template", id: row.link },
      { name: row.name, from: String(p.current_version), to: String(to) },
    );
    await audit(t, {
      actorAccountId: actor,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "agent_template.updated",
      target: id,
      detail: { name: row.name, platformId: row.link, from: p.current_version, to },
    });
    return this.detail(orgId, id);
  }

  /**
   * The org's own template `id` (an org template; promoted ones with their platform link), or
   * undefined: another org's, a plugin's, or a copy of a platform template it does not own.
   */
  private async ownRow(
    orgId: string,
    id: string,
    forUpdate: boolean,
  ): Promise<OwnTemplateRow | undefined> {
    let q = this.db
      .selectFrom("agent_templates as t")
      .leftJoin("platform_agent_templates as p", "p.id", "t.platform_template_id")
      .select([
        "t.id",
        "t.name",
        "t.current_version",
        "t.shareable",
        "t.platform_template_id",
        "t.pinned_version",
        "p.owner_org_id",
        "p.deleted_at as p_deleted_at",
      ])
      .where("t.id", "=", id)
      .where("t.org_id", "=", orgId)
      .where("t.deleted_at", "is", null)
      .where("t.plugin_name", "is", null)
      .where("t.catalog_item_id", "is", null);
    if (forUpdate) q = q.forUpdate("t");
    const r = await q.executeTakeFirst();
    if (!r) return undefined;
    if (r.platform_template_id === null) {
      return {
        id: r.id,
        name: r.name,
        current_version: r.current_version,
        shareable: r.shareable,
        link: null,
      };
    }
    const promoted =
      r.pinned_version === null && r.owner_org_id === orgId && r.p_deleted_at === null;
    if (!promoted) return undefined;
    return {
      id: r.id,
      name: r.name,
      current_version: r.current_version,
      shareable: r.shareable,
      link: r.platform_template_id,
    };
  }

  /** 409 `catalog.not_owned` for a template the org has but does not own, else 404. */
  private async notOwnedOrMissing(orgId: string, id: string): Promise<ApiError> {
    const t = (await loadTemplates(this.db, orgId, [id])).get(id);
    if (!t) return notFound();
    return new ApiError(
      "catalog.not_owned",
      `${t.name} is not this organization's own agent template; only its owner can change it`,
    );
  }

  /**
   * The owner of a usable template the org does not own itself: a platform template's (or a
   * linked copy's) `owner_org_id`, a plugin template's catalog item owner, else the platform.
   */
  private async ownerOfRow(orgId: string, t: TemplateRow): Promise<Owner> {
    const db = this.db;
    let ownerOrgId: string | null = null;
    if (t.platformTemplateId !== undefined || t.ownedCopy) {
      const pid =
        t.platformTemplateId ??
        (
          await db
            .selectFrom("agent_templates")
            .select("platform_template_id")
            .where("id", "=", t.id)
            .executeTakeFirst()
        )?.platform_template_id ??
        null;
      if (pid !== null) {
        ownerOrgId =
          (
            await db
              .selectFrom("platform_agent_templates")
              .select("owner_org_id")
              .where("id", "=", pid)
              .executeTakeFirst()
          )?.owner_org_id ?? null;
      }
    } else if (t.catalogItemId !== null) {
      ownerOrgId =
        (
          await db
            .selectFrom("catalog_items")
            .select("owner_org_id")
            .where("id", "=", t.catalogItemId)
            .executeTakeFirst()
        )?.owner_org_id ?? null;
    } else if (t.plugin === null) {
      // an org row without a plugin is the org's own
      ownerOrgId = orgId;
    }
    return ownerOf(ownerOrgId, await ownersOf(db, ownerOrgId === null ? [] : [ownerOrgId]));
  }
}
