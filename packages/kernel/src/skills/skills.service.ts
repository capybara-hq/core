import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import {
  type AttachmentsService,
  type CreatedAttachment,
  SKILL_PACKAGE_CONTENT_TYPE,
  skillFilesPrefix,
} from "../conversations/attachments.service.js";
import type { KernelDatabase, KernelDb, SkillManifest } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import type { StorageService } from "../storage/storage.service.js";
import { readSkillPackage } from "./package.js";

type Trx = Transaction<KernelDatabase>;

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
}

/** `POST /skills` 的结果：`created` 为 true 表示新技能，否则是已有技能的新版本。 */
export interface UploadedSkill {
  skill: SkillSummary;
  version: number;
  created: boolean;
}

export interface SkillsDeps {
  db: KernelDb;
  storage: StorageService;
  attachments: Pick<AttachmentsService, "create" | "readSkillPackage" | "consumeSkillPackage">;
}

const notFound = () => new ApiError("skill.not_found", "Skill not found");

/**
 * 在调用方事务里核对 agent 定义引用的组织技能：每个 id 都必须是该组织未删除的 `scope=org` 技能，
 * 否则 `validation_failed`（path `skills.orgSkills.<i>`）；不可重复。调用方须已锁组织行（技能删除同样锁组织行，二者串行）。
 * `kept`：当前版本里已有的引用（保存时合法），修改时不再核对——技能之后被删也不挡住其他改动（运行时由 T14 忽略已删除的技能）。
 */
export async function assertOrgSkills(
  t: Trx,
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
    const found = await t
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

const summary = (r: {
  id: string;
  scope: "org" | "agent";
  agent_id: string | null;
  name: string;
  description: string;
  current_version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}): SkillSummary => ({
  id: r.id,
  scope: r.scope,
  agentId: r.agent_id,
  name: r.name,
  description: r.description,
  currentVersion: r.current_version,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SUMMARY_COLUMNS = [
  "id",
  "scope",
  "agent_id",
  "name",
  "description",
  "current_version",
  "created_by",
  "created_at",
  "updated_at",
] as const;

/**
 * 技能库（M5 T13）：组织技能的上传（新技能或新版本）、列表、详情与软删除。
 * 字节在对象存储 `kernel/<orgId>/skills/<uploadId>/<path>`，元数据在 PG；无进程内状态，可多副本共用。
 */
export class SkillsService {
  constructor(private readonly d: SkillsDeps) {}

  /** 登记一个技能包上传（预签名 POST，`application/zip`，≤ 50MB）；角色由路由的 `skills.manage` 把关。 */
  async createUpload(
    orgId: string,
    accountId: string,
    input: { name: string; size: number },
  ): Promise<CreatedAttachment> {
    return this.d.attachments.create(
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
    this.d.storage.assertAvailable();
    const prefix = skillFilesPrefix(uploadId);
    // 重试（上次已提交、响应丢了）：同一上传已产生的版本直接返回，不再要求上传仍可用
    const done = await this.d.db
      .selectFrom("skill_versions")
      .innerJoin("skills", "skills.id", "skill_versions.skill_id")
      .select(["skills.id", "skill_versions.version"])
      .where("skill_versions.object_prefix", "=", prefix)
      .where("skills.org_id", "=", orgId)
      .where("skill_versions.created_by", "=", actorAccountId)
      .where("skills.deleted_at", "is", null)
      .executeTakeFirst();
    if (done) {
      const row = await this.d.db
        .selectFrom("skills")
        .select(SUMMARY_COLUMNS)
        .where("id", "=", done.id)
        .executeTakeFirstOrThrow();
      return { skill: summary(row), version: done.version, created: done.version === 1 };
    }
    const zip = await this.d.attachments.readSkillPackage(orgId, actorAccountId, uploadId);
    const pkg = await readSkillPackage(zip);
    const store = this.d.storage.kernel(orgId);
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
    const manifest: SkillManifest = {
      name: pkg.name,
      description: pkg.description,
      files: pkg.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    };
    return this.d.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "skills.manage");
      await this.d.attachments.consumeSkillPackage(t, orgId, actorAccountId, uploadId);
      const existing = await t
        .selectFrom("skills")
        .select(["id", "current_version"])
        .where("org_id", "=", orgId)
        .where("scope", "=", "org")
        .where("name", "=", pkg.name)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      const id = existing?.id ?? randomUUID();
      const version = (existing?.current_version ?? 0) + 1;
      if (existing) {
        await t
          .updateTable("skills")
          .set({ current_version: version, description: pkg.description, updated_at: sql`now()` })
          .where("id", "=", id)
          .execute();
      } else {
        await t
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
          })
          .execute();
      }
      await t
        .insertInto("skill_versions")
        .values({
          skill_id: id,
          version,
          manifest: JSON.stringify(manifest),
          object_prefix: prefix,
          created_by: actorAccountId,
        })
        .execute();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: existing ? "skill.version_created" : "skill.created",
        target: id,
        detail: { name: pkg.name, version, files: manifest.files.length },
      });
      const row = await t
        .selectFrom("skills")
        .select(SUMMARY_COLUMNS)
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return { skill: summary(row), version, created: !existing };
    });
  }

  /** 组织技能库（`scope=org`、未删除），按名字排序。 */
  async list(orgId: string): Promise<SkillSummary[]> {
    const rows = await this.d.db
      .selectFrom("skills")
      .select(SUMMARY_COLUMNS)
      .where("org_id", "=", orgId)
      .where("scope", "=", "org")
      .where("deleted_at", "is", null)
      .orderBy("name")
      .execute();
    return rows.map(summary);
  }

  /** 对该 agent 自动生效的技能（`scope=agent`、未删除），按名字排序。 */
  async listForAgent(orgId: string, agentId: string): Promise<SkillSummary[]> {
    const rows = await this.d.db
      .selectFrom("skills")
      .select(SUMMARY_COLUMNS)
      .where("org_id", "=", orgId)
      .where("scope", "=", "agent")
      .where("agent_id", "=", agentId)
      .where("deleted_at", "is", null)
      .orderBy("name")
      .execute();
    return rows.map(summary);
  }

  /** 组织技能详情：各版本与文件清单。不存在 / 已删除 / 不是组织技能 → `skill.not_found`。 */
  async get(orgId: string, skillId: string): Promise<SkillDetail> {
    const row = await this.d.db
      .selectFrom("skills")
      .select(SUMMARY_COLUMNS)
      .where("id", "=", skillId)
      .where("org_id", "=", orgId)
      .where("scope", "=", "org")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw notFound();
    const versions = await this.d.db
      .selectFrom("skill_versions")
      .select(["version", "manifest", "created_by", "created_at"])
      .where("skill_id", "=", skillId)
      .orderBy("version", "desc")
      .execute();
    return {
      ...summary(row),
      versions: versions.map((v) => ({
        version: v.version,
        description: v.manifest.description,
        files: v.manifest.files,
        createdBy: v.created_by,
        createdAt: v.created_at,
      })),
    };
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
    await this.d.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "skills.manage");
      const r = await t
        .updateTable("skills")
        .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
        .where("id", "=", skillId)
        .where("org_id", "=", orgId)
        .where("scope", "=", "org")
        .where("deleted_at", "is", null)
        .returning(["name"])
        .executeTakeFirst();
      if (!r) throw notFound();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "skill.deleted",
        target: skillId,
        detail: { name: r.name },
      });
    });
  }
}
