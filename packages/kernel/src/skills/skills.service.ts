import { randomUUID } from "node:crypto";
import { parseSkillMd, SKILL_ENTRY_FILE, type SkillInvocation } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { AgentDefinition } from "../agents/definition.js";
import { assertItemInstallable } from "../catalog/requests.service.js";
import {
  type CreatedAttachment,
  SKILL_PACKAGE_CONTENT_TYPE,
  skillFilesPrefix,
} from "../conversations/attachments.service.js";
import type { KernelSchemaDb, SkillManifest, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { assertCustomAllowed } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { legacyCurrentTrx } from "../infra/database/legacy-view.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LegacyPorts } from "../lifecycle/legacy-ports.js";
import { OrgLock } from "../orgs/org-lock.js";
import { textBytesTokens } from "../runtime/context/tokens.js";
import { StorageService } from "../storage/storage.service.js";
import { invocationOf, PINNED_SKILLS_LIMITS } from "./catalog.js";
import { readSkillPackage, type SkillPackageFile, storedInvocation } from "./package.js";

/** Where an org skill came from (spec §9.2): the org's own, or a catalog plugin at a version. */
export type SkillSource = { kind: "org" } | { kind: "plugin"; name: string; version: string };

/** An org skill that a plugin install would overwrite. */
export interface SkillConflict {
  skill: string;
  source: SkillSource;
}

/**
 * The live org skills named in `skillNames` whose provenance is not catalog item `itemId` (spec
 * §9.2, Decision 8): the org's own skills (`catalog_item_id` null: uploaded or written by an
 * agent) and the skills of other catalog items. A skill of the same item (a reinstall or upgrade)
 * is not a conflict. In the order of `skillNames`.
 */
export async function skillConflicts(
  db: KernelSchemaDb,
  orgId: string,
  itemId: string,
  skillNames: readonly string[],
): Promise<SkillConflict[]> {
  if (skillNames.length === 0) return [];
  const rows = await db
    .selectFrom("skills as s")
    .leftJoin("catalog_items as i", "i.id", "s.catalog_item_id")
    .select(["s.name", "s.catalog_item_id", "s.catalog_version", "i.name as item_name"])
    .where("s.org_id", "=", orgId)
    .where("s.scope", "=", "org")
    .where("s.deleted_at", "is", null)
    .where("s.name", "in", [...skillNames])
    .where((eb) =>
      eb.or([eb("s.catalog_item_id", "is", null), eb("s.catalog_item_id", "<>", itemId)]),
    )
    .execute();
  const byName = new Map(rows.map((r) => [r.name, r]));
  const out: SkillConflict[] = [];
  for (const name of new Set(skillNames)) {
    const r = byName.get(name);
    if (!r) continue;
    out.push({
      skill: name,
      source:
        r.catalog_item_id === null
          ? { kind: "org" }
          : {
              kind: "plugin",
              name: r.item_name ?? r.catalog_item_id,
              version: r.catalog_version ?? "",
            },
    });
  }
  return out;
}

/** One line of the conflict message (spec §9.2). */
export function skillConflictLine(c: SkillConflict): string {
  const source =
    c.source.kind === "org"
      ? "the org's own skill"
      : `plugin "${c.source.name}" ${c.source.version}`.trimEnd();
  return `Skill "${c.skill}" already exists in this org (source: ${source}). Remove or rename it, then install again.`;
}

/** 409 `plugin.skill_conflict`: one message line and one detail per conflicting skill. */
export function skillConflictError(conflicts: readonly SkillConflict[]): ApiError {
  return new ApiError(
    "plugin.skill_conflict",
    conflicts.map(skillConflictLine).join("\n"),
    conflicts.map((c) => ({ skill: c.skill, source: c.source })),
  );
}

/** 写技能文件时的并发数。 */
const PUT_CONCURRENCY = 4;

/** 技能列表项。 */
export interface SkillSummary {
  id: string;
  scope: "org" | "agent";
  agentId: string | null;
  name: string;
  description: string;
  currentVersion: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** The catalog item name the skill came from; null for the org's own (uploaded or written). */
  plugin: string | null;
  /** The format of the plugin the current version came from. */
  sourceFormat: SourceFormat;
  /** The plugin suggests pinning the current version (spec §9.1). */
  suggestPinned: boolean;
  /** SKILL.md size of the current version, in bytes (0 when the manifest has none). */
  entryBytes: number;
  /** Token estimate of the SKILL.md of the current version (ASCII rule: bytes / 4). */
  tokenEstimate: number;
  /** Phase D: the current version is manual-only (not in the model's catalog). */
  manual: boolean;
  /** Phase D: the current version runs as a sub-agent when a person invokes it. */
  fork: boolean;
}

/** 技能的一个版本（含文件清单）。 */
export interface SkillVersionView {
  version: number;
  files: SkillManifest["files"];
  description: string;
  createdBy: string;
  createdAt: Date;
}

/** 技能详情：各版本新的在前。 */
export interface SkillDetail extends SkillSummary {
  versions: SkillVersionView[];
  /**
   * 当前版本 SKILL.md 的正文（去掉 frontmatter；网页按纯文本显示）。超过 {@link SKILL_BODY_MAX_BYTES}、
   * 读不到（对象缺失、存储不可用）或不是 UTF-8 时为 null。
   */
  body: string | null;
}

/** 详情里读取 SKILL.md 正文的上限。 */
export const SKILL_BODY_MAX_BYTES = 1024 * 1024;

/** `POST /skills` 的结果：`created` 为 true 表示新技能，否则是已有技能的新版本。 */
export interface UploadedSkill {
  skill: SkillSummary;
  version: number;
  created: boolean;
}

const notFound = () => new ApiError("skill.not_found", "Skill not found");

/**
 * 在调用方事务里核对 agent 定义引用的组织技能：每个 id 都必须是该组织未删除的 `scope=org` 技能，
 * 否则 `validation_failed`（path `skills.orgSkills.<i>`）；不可重复。调用方须已锁组织行（技能删除同样锁组织行，二者串行）。
 * `kept`：当前版本里已有的引用（保存时合法），修改时不再核对——技能之后被删也不挡住其他改动（运行时由 T14 忽略已删除的技能）。
 */
export async function assertOrgSkills(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[],
  kept: ReadonlySet<string> = new Set(),
): Promise<void> {
  const details: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) details.push({ path: `skills.orgSkills.${i}`, message: "Duplicate skill" });
    seen.add(id);
  });
  const toCheck = [...seen].filter((id) => !kept.has(id));
  if (toCheck.length > 0) {
    const found = await db
      .selectFrom("skills")
      .select("id")
      .where("org_id", "=", orgId)
      .where("scope", "=", "org")
      .where("deleted_at", "is", null)
      .where("id", "in", toCheck)
      .execute();
    const live = new Set([...kept, ...found.map((r) => r.id)]);
    ids.forEach((id, i) => {
      if (!live.has(id)) {
        details.push({
          path: `skills.orgSkills.${i}`,
          message: `Skill ${id} does not exist in this organization or has been deleted`,
        });
      }
    });
  }
  if (details.length > 0) {
    throw new ApiError("validation_failed", "Invalid skill references", details);
  }
}

interface SummaryRow {
  id: string;
  scope: "org" | "agent";
  agent_id: string | null;
  name: string;
  description: string;
  current_version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  item_name: string | null;
  source_format: SourceFormat | null;
  suggest_pinned: boolean | null;
  manifest: SkillManifest | null;
}

/** Why a pinned skill reference is refused (`agent.pinned_invalid` details). */
export type PinnedSkillProblem =
  | "not_selected"
  | "not_found"
  | "duplicate"
  | "too_many"
  | "too_large"
  /** Phase D: the skill's current version is manual-only (not in the model's catalog). */
  | "manual_only";

/**
 * Checks `skills.pinned` of an agent definition in the caller's transaction (the org row is locked,
 * like {@link assertOrgSkills}); throws 400 `agent.pinned_invalid` with one detail per problem
 * (`{ skill, reason, totalBytes? }`):
 * - `duplicate`: an id listed twice; `too_many`: every id past {@link PINNED_SKILLS_LIMITS}.count;
 * - each newly added id (not in `kept`, the current definition's pinned ids) must be a live org
 *   skill listed in `skills.orgSkills` (else `not_selected`) or a live skill of this agent
 *   (`agentId`; null when creating), else `not_found`. Kept ids are not re-checked: a pinned skill
 *   deleted later does not block other edits (the run ignores it);
 * - `manual_only` (phase D): a newly added id whose current version is manual-only
 *   (`invocation.model === false`); a kept one that became manual-only is dropped at run time;
 * - `too_large`: the current SKILL.md sizes of the live pinned skills total more than
 *   {@link PINNED_SKILLS_LIMITS}.totalBytes (named by the first skill past the limit). Checked only
 *   when the pinned list changed: a pinned skill's new version never blocks an unrelated edit (the
 *   run keeps what fits).
 */
export async function assertPinnedSkills(
  db: KernelSchemaDb,
  orgId: string,
  agentId: string | null,
  skills: AgentDefinition["skills"],
  kept: readonly string[] = [],
): Promise<void> {
  const pinned = skills?.pinned;
  if (pinned === undefined) return;
  const details: { skill: string; reason: PinnedSkillProblem; totalBytes?: number }[] = [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of pinned) {
    if (seen.has(id)) {
      details.push({ skill: id, reason: "duplicate" });
      continue;
    }
    seen.add(id);
    if (unique.length >= PINNED_SKILLS_LIMITS.count) {
      details.push({ skill: id, reason: "too_many" });
      continue;
    }
    unique.push(id);
  }
  const rows =
    unique.length === 0
      ? []
      : await db
          .selectFrom("skills as s")
          .innerJoin("skill_versions as v", (j) =>
            j.onRef("v.skill_id", "=", "s.id").onRef("v.version", "=", "s.current_version"),
          )
          .select(["s.id", "s.scope", "s.agent_id", "v.manifest"])
          .where("s.org_id", "=", orgId)
          .where("s.deleted_at", "is", null)
          .where("s.id", "in", unique)
          .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keptSet = new Set(kept);
  const selected = new Set(skills?.orgSkills ?? []);
  for (const id of unique) {
    if (keptSet.has(id)) continue;
    const r = byId.get(id);
    const own = r?.scope === "agent" && agentId !== null && r.agent_id === agentId;
    if (!r || (r.scope === "agent" && !own)) details.push({ skill: id, reason: "not_found" });
    else if (r.scope === "org" && !selected.has(id))
      details.push({ skill: id, reason: "not_selected" });
    else if (!invocationOf(r.manifest).model) details.push({ skill: id, reason: "manual_only" });
  }
  const changed = pinned.length !== kept.length || pinned.some((id, i) => kept[i] !== id);
  if (details.length === 0 && changed) {
    let total = 0;
    let over: string | undefined;
    for (const id of unique) {
      const size = byId.get(id)?.manifest.files.find((f) => f.path === SKILL_ENTRY_FILE)?.size ?? 0;
      total += size;
      if (over === undefined && total > PINNED_SKILLS_LIMITS.totalBytes) over = id;
    }
    if (over !== undefined) details.push({ skill: over, reason: "too_large", totalBytes: total });
  }
  if (details.length > 0) {
    throw new ApiError(
      "agent.pinned_invalid",
      `Invalid pinned skills: ${details.map((d) => `${d.skill} (${d.reason})`).join(", ")}`,
      details,
    );
  }
}

const summary = (r: SummaryRow): SkillSummary => {
  const entryBytes = r.manifest?.files.find((f) => f.path === SKILL_ENTRY_FILE)?.size ?? 0;
  const inv = r.manifest ? invocationOf(r.manifest) : { model: true, user: true };
  return {
    id: r.id,
    scope: r.scope,
    agentId: r.agent_id,
    name: r.name,
    description: r.description,
    currentVersion: r.current_version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    plugin: r.item_name,
    sourceFormat: r.source_format ?? "capybara",
    suggestPinned: r.suggest_pinned ?? false,
    entryBytes,
    tokenEstimate: textBytesTokens(entryBytes),
    manual: inv.model === false,
    fork: inv.fork !== undefined,
  };
};

/**
 * Skills with their summary columns: the catalog item name (provenance) and the current version's
 * source format, pinned suggestion and manifest.
 */
const summaryQuery = (db: KernelSchemaDb) =>
  db
    .selectFrom("skills as s")
    .leftJoin("catalog_items as i", "i.id", "s.catalog_item_id")
    .leftJoin("skill_versions as v", (j) =>
      j.onRef("v.skill_id", "=", "s.id").onRef("v.version", "=", "s.current_version"),
    )
    .select([
      "s.id",
      "s.scope",
      "s.agent_id",
      "s.name",
      "s.description",
      "s.current_version",
      "s.created_by",
      "s.created_at",
      "s.updated_at",
      "i.name as item_name",
      "v.source_format",
      "v.suggest_pinned",
      "v.manifest",
    ]);

/**
 * 技能库（M5 T13）：组织技能的上传（新技能或新版本）、列表、详情与软删除。
 * 字节在对象存储 `kernel/<orgId>/skills/<uploadId>/<path>`，元数据在 PG；无进程内状态，可多副本共用。
 */
@Injectable()
export class SkillsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(LegacyPorts) private readonly ports: LegacyPorts,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
  ) {}

  /** 登记一个技能包上传（预签名 POST，`application/zip`，≤ 50MB）；角色由路由的 `skills.manage` 把关。 */
  async createUpload(
    orgId: string,
    accountId: string,
    input: { name: string; size: number },
  ): Promise<CreatedAttachment> {
    // 部署设置 customSkills 为 deny：组织只能从企业目录安装技能（C22）
    await assertCustomAllowed(this.db.db, "customSkills");
    return this.ports.attachments.create(
      orgId,
      accountId,
      { name: input.name, contentType: SKILL_PACKAGE_CONTENT_TYPE, size: input.size },
      "skill-package",
    );
  }

  /**
   * 用一个技能包上传创建技能或新增版本：
   * 1. 取上传的 zip（只有上传者；未 finalize 的先 finalize），解包校验（`skill.invalid_package`）；
   * 2. 把文件写到 `skills/<uploadId>/`（键只取决于上传 id 与包内路径：重试幂等）；
   * 3. 一个事务里：锁组织行并复核 `skills.manage`，把上传标记为已用掉（并发的同一上传只有一个成功），
   *    同名未删除的组织技能存在则 `current_version + 1`，否则新建（组织行锁串行化，版本号不会重复），写版本与审计。
   * 第 3 步之前中断不会留下可见的版本；已写的文件由清理任务在上传过期后删除（未被任何版本引用时）。
   * 同一上传已经产生过版本（上次提交了、响应丢了而重试）→ 直接返回那个版本（同组织、同一发起人）。
   */
  async upload(
    orgId: string,
    actorAccountId: string,
    uploadId: string,
    actorTokenId?: string,
  ): Promise<UploadedSkill> {
    this.storage.assertAvailable();
    const prefix = skillFilesPrefix(uploadId);
    // 重试（上次已提交、响应丢了）：同一上传已产生的版本直接返回，不再要求上传仍可用
    const done = await this.db
      .selectFrom("skill_versions")
      .innerJoin("skills", "skills.id", "skill_versions.skill_id")
      .select(["skills.id", "skill_versions.version"])
      .where("skill_versions.object_prefix", "=", prefix)
      .where("skills.org_id", "=", orgId)
      .where("skill_versions.created_by", "=", actorAccountId)
      .where("skills.deleted_at", "is", null)
      .executeTakeFirst();
    if (done) {
      const row = await summaryQuery(this.db.db)
        .where("s.id", "=", done.id)
        .executeTakeFirstOrThrow();
      return { skill: summary(row), version: done.version, created: done.version === 1 };
    }
    // 自建被禁止时先拒绝（事务里再复核一次）
    await assertCustomAllowed(this.db.db, "customSkills");
    const zip = await this.ports.attachments.readSkillPackage(orgId, actorAccountId, uploadId);
    const pkg = await readSkillPackage(zip);
    return this.createVersionFromFiles(orgId, actorAccountId, pkg, {
      prefix,
      ...(actorTokenId !== undefined && { actorTokenId }),
      inTransaction: async () => {
        await assertCustomAllowed(this.db.db, "customSkills");
        await this.ports.attachments.consumeSkillPackage(
          legacyCurrentTrx(),
          orgId,
          actorAccountId,
          uploadId,
        );
      },
    });
  }

  /**
   * 用一组已校验的技能文件创建组织技能或给同名技能新增版本（上传与企业目录安装共用）：
   * 1. 把文件写到 `kernel/<orgId>/<prefix>`（缺省 `skills/<新 id>/`）；
   * 2. 一个事务里：锁组织行并复核 `skills.manage`，执行 `inTransaction`（上传：标记上传已用；目录：按条目策略复核），
   *    同名未删除的组织技能存在则 `current_version + 1`，否则新建；技能与版本都记下 `directory` 来源（没有则清空：
   *    自定义上传盖在目录技能上就不再算目录安装），写版本与审计
   *    （`skill.created` / `skill.version_created`，目录安装时 detail 带 directory）。
   */
  async createVersionFromFiles(
    orgId: string,
    actorAccountId: string,
    pkg: {
      name: string;
      description: string;
      files: SkillPackageFile[];
      /** Phase D: stored in the manifest when it is not the default. */
      invocation?: SkillInvocation;
    },
    opts: {
      prefix?: string;
      actorTokenId?: string;
      /** Runs first inside the transaction (after the org lock). */
      inTransaction?: () => Promise<void>;
      /** Catalog provenance; `approvedBy` is the item whose policy approves it (default `itemId`). */
      catalog?: {
        itemId: string;
        version: string;
        approvedBy?: string;
        /** The catalog version's source format (default capybara). */
        format?: SourceFormat;
        /** The plugin manifest suggests pinning this skill (spec §9.1). */
        suggestPinned?: boolean;
      };
    } = {},
  ): Promise<UploadedSkill> {
    this.storage.assertAvailable();
    const prefix = opts.prefix ?? skillFilesPrefix(randomUUID());
    const store = this.storage.kernel(orgId);
    const queue = [...pkg.files];
    await Promise.all(
      Array.from({ length: Math.min(PUT_CONCURRENCY, queue.length) }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          await store.put(`${prefix}${f.path}`, f.data, {
            contentType: "application/octet-stream",
            size: f.size,
          });
        }
      }),
    );
    const invocation = pkg.invocation && storedInvocation(pkg.invocation);
    const manifest: SkillManifest = {
      name: pkg.name,
      description: pkg.description,
      files: pkg.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      ...(invocation !== undefined && { invocation }),
    };
    return this.createVersionIn(orgId, actorAccountId, pkg, manifest, prefix, opts);
  }

  /** The transaction of {@link createVersionFromFiles}. */
  @Transactional()
  private async createVersionIn(
    orgId: string,
    actorAccountId: string,
    pkg: { name: string; description: string },
    manifest: SkillManifest,
    prefix: string,
    opts: Parameters<SkillsService["createVersionFromFiles"]>[3] & {},
  ): Promise<UploadedSkill> {
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "skills.manage");
    if (opts.catalog) {
      const c = opts.catalog;
      await assertItemInstallable(legacyCurrentTrx(), orgId, c.itemId, c.approvedBy ?? c.itemId);
    }
    await opts.inTransaction?.();
    const existing = await this.db
      .selectFrom("skills")
      .select(["id", "current_version", "catalog_item_id"])
      .where("org_id", "=", orgId)
      .where("scope", "=", "org")
      .where("name", "=", pkg.name)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    // A catalog install never overwrites a skill of other provenance (spec §9.2; planning checks
    // it first, this closes the race with a skill created since)
    if (existing && opts.catalog && existing.catalog_item_id !== opts.catalog.itemId) {
      const conflicts = await skillConflicts(this.db.db, orgId, opts.catalog.itemId, [pkg.name]);
      if (conflicts.length > 0) throw skillConflictError(conflicts);
    }
    const id = existing?.id ?? randomUUID();
    const version = (existing?.current_version ?? 0) + 1;
    // 来源跟着最新版本走：目录安装记条目与版本，自定义上传清掉（内容已不是目录里的那份）
    const provenance = {
      catalog_item_id: opts.catalog?.itemId ?? null,
      catalog_version: opts.catalog?.version ?? null,
    };
    if (existing) {
      await this.db
        .updateTable("skills")
        .set({
          current_version: version,
          description: pkg.description,
          ...provenance,
          updated_at: sql`now()`,
        })
        .where("id", "=", id)
        .execute();
    } else {
      await this.db
        .insertInto("skills")
        .values({
          id,
          org_id: orgId,
          scope: "org",
          agent_id: null,
          name: pkg.name,
          description: pkg.description,
          current_version: 1,
          created_by: actorAccountId,
          ...provenance,
        })
        .execute();
    }
    await this.db
      .insertInto("skill_versions")
      .values({
        skill_id: id,
        version,
        manifest: JSON.stringify(manifest),
        object_prefix: prefix,
        created_by: actorAccountId,
        ...provenance,
        source_format: opts.catalog?.format ?? "capybara",
        suggest_pinned: opts.catalog?.suggestPinned ?? false,
      })
      .execute();
    await audit(this.db.db, {
      actorAccountId,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId,
      action: existing ? "skill.version_created" : "skill.created",
      target: id,
      detail: {
        name: pkg.name,
        version,
        files: manifest.files.length,
        ...(opts.catalog && { catalog: opts.catalog }),
      },
    });
    const row = await summaryQuery(this.db.db).where("s.id", "=", id).executeTakeFirstOrThrow();
    return { skill: summary(row), version, created: !existing };
  }

  /**
   * In the caller's transaction (`mandatory`: the caller holds the org row lock), reverts the
   * version a plugin install added to an existing skill: only while `version` is still current,
   * back to the previous version, deleting this version's row (returns false when a newer version
   * exists); the skill's description and catalog source revert too. Audit `skill.version_reverted`.
   */
  @Transactional({ propagation: "mandatory" })
  async revertVersionIn(
    orgId: string,
    skillId: string,
    version: number,
    actorAccountId: string,
    reason: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom("skills")
      .select(["current_version", "name"])
      .where("id", "=", skillId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.current_version !== version || version <= 1) return false;
    const prev = await this.db
      .selectFrom("skill_versions")
      .select(["manifest", "catalog_item_id", "catalog_version"])
      .where("skill_id", "=", skillId)
      .where("version", "=", version - 1)
      .executeTakeFirst();
    await this.db
      .updateTable("skills")
      .set({
        current_version: version - 1,
        ...(prev && {
          description: prev.manifest.description,
          catalog_item_id: prev.catalog_item_id,
          catalog_version: prev.catalog_version,
        }),
        updated_at: sql`now()`,
      })
      .where("id", "=", skillId)
      .execute();
    await this.db
      .deleteFrom("skill_versions")
      .where("skill_id", "=", skillId)
      .where("version", "=", version)
      .execute();
    await audit(this.db.db, {
      actorAccountId,
      orgId,
      action: "skill.version_reverted",
      target: skillId,
      detail: { name: row.name, version, reason },
    });
    return true;
  }

  /**
   * In the caller's transaction (`mandatory`: the caller holds the org row lock), soft-deletes an
   * org skill (plugin install rollback and uninstall). Audit `skill.deleted` with the reason.
   * Returns false when it is already deleted or missing.
   */
  @Transactional({ propagation: "mandatory" })
  async softDeleteIn(
    orgId: string,
    skillId: string,
    actorAccountId: string,
    reason: string,
  ): Promise<boolean> {
    const r = await this.db
      .updateTable("skills")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", skillId)
      .where("org_id", "=", orgId)
      .where("scope", "=", "org")
      .where("deleted_at", "is", null)
      .returning(["name"])
      .executeTakeFirst();
    if (!r) return false;
    await audit(this.db.db, {
      actorAccountId,
      orgId,
      action: "skill.deleted",
      target: skillId,
      detail: { name: r.name, reason },
    });
    return true;
  }

  /** 组织技能库（`scope=org`、未删除），按名字排序。 */
  async list(orgId: string): Promise<SkillSummary[]> {
    const rows = await summaryQuery(this.db.db)
      .where("s.org_id", "=", orgId)
      .where("s.scope", "=", "org")
      .where("s.deleted_at", "is", null)
      .orderBy("s.name")
      .execute();
    return rows.map(summary);
  }

  /** 对该 agent 自动生效的技能（`scope=agent`、未删除），按名字排序。 */
  async listForAgent(orgId: string, agentId: string): Promise<SkillSummary[]> {
    const rows = await summaryQuery(this.db.db)
      .where("s.org_id", "=", orgId)
      .where("s.scope", "=", "agent")
      .where("s.agent_id", "=", agentId)
      .where("s.deleted_at", "is", null)
      .orderBy("s.name")
      .execute();
    return rows.map(summary);
  }

  /** 组织技能详情：各版本与文件清单。不存在 / 已删除 / 不是组织技能 → `skill.not_found`。 */
  async get(orgId: string, skillId: string): Promise<SkillDetail> {
    const row = await summaryQuery(this.db.db)
      .where("s.id", "=", skillId)
      .where("s.org_id", "=", orgId)
      .where("s.scope", "=", "org")
      .where("s.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw notFound();
    const versions = await this.db
      .selectFrom("skill_versions")
      .select(["version", "manifest", "created_by", "created_at", "object_prefix"])
      .where("skill_id", "=", skillId)
      .orderBy("version", "desc")
      .execute();
    const current = versions.find((v) => v.version === row.current_version);
    return {
      ...summary(row),
      body: current ? await this.readBody(orgId, current) : null,
      versions: versions.map((v) => ({
        version: v.version,
        description: v.manifest.description,
        files: v.manifest.files,
        createdBy: v.created_by,
        createdAt: v.created_at,
      })),
    };
  }

  /** 读某版本 SKILL.md 的正文（见 {@link SkillDetail.body}）；任何读取问题都返回 null，不让详情失败。 */
  private async readBody(
    orgId: string,
    v: { manifest: SkillManifest; object_prefix: string },
  ): Promise<string | null> {
    const entry = v.manifest.files.find((f) => f.path === SKILL_ENTRY_FILE);
    if (!entry || entry.size > SKILL_BODY_MAX_BYTES) return null;
    try {
      const got = await this.storage.kernel(orgId).get(`${v.object_prefix}${SKILL_ENTRY_FILE}`);
      if (!got) return null;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await new Response(got.body).arrayBuffer(),
      );
      const parsed = parseSkillMd(text, { invocationKeys: false });
      return "errors" in parsed ? text : parsed.body;
    } catch {
      return null;
    }
  }

  /**
   * 软删除组织技能（`skills.manage`，在组织行锁内复核）。之后同名可重新上传为新技能；引用它的 agent 定义
   * 保存时会被拒绝（运行时由 T14 忽略已删除的技能）。不存在 / 已删除 → `skill.not_found`。
   */
  async softDelete(
    orgId: string,
    skillId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.softDeleteTx(orgId, skillId, actorAccountId, actorTokenId);
  }

  /** The transaction of {@link softDelete}. */
  @Transactional()
  private async softDeleteTx(
    orgId: string,
    skillId: string,
    actorAccountId: string,
    actorTokenId: string | undefined,
  ): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "skills.manage");
    const r = await this.db
      .updateTable("skills")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", skillId)
      .where("org_id", "=", orgId)
      .where("scope", "=", "org")
      .where("deleted_at", "is", null)
      .returning(["name"])
      .executeTakeFirst();
    if (!r) throw notFound();
    await audit(this.db.db, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "skill.deleted",
      target: skillId,
      detail: { name: r.name },
    });
  }
}
