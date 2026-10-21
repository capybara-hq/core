import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { StorageService } from "../storage/storage.service.js";
import { UUID_RE } from "../ui/registry.js";
import type { EventPayload } from "./events.js";

/** 产物下载跳转的预签名有效期（秒）。 */
export const ARTIFACT_DOWNLOAD_TTL_SECONDS = 300;
/** 下载 302 的 `Cache-Control: private, max-age=…`（秒），不长于预签名有效期。 */
export const ARTIFACT_DOWNLOAD_CACHE_SECONDS = 60;

export interface ConversationArtifactsDeps {
  db: KernelDb;
  storage: Pick<StorageService, "kernel">;
  /** 会话可见性（与会话 SSE 流同一判定：`ConversationsService.isAccessible`）。 */
  isAccessible(orgId: string, conversationId: string, viewerAccountId: string): Promise<boolean>;
}

const conversationNotFound = () => new ApiError("conversation.not_found", "Conversation not found");
const artifactNotFound = () =>
  new ApiError("conversation.artifact_not_found", "Artifact not found");

/**
 * 产物下载（M5 T8）：agent 经 `sandbox_deliver` 交付的文件。先按会话流的规则判定会话可见
 * （不可见 → `conversation.not_found`），再只在这个会话的日志里找 `artifact_created`
 * （没有 → `conversation.artifact_not_found`），302 到预签名地址：一律 `attachment`（不在页面里渲染），
 * 带交付时的文件名与类型。
 *
 * 查找走 `conversation_events` 的主键 `(conversation_id, seq)` 前缀，在 SQL 里按 `type` 与
 * `payload->>'artifactId'` 过滤、`LIMIT 1`（只扫这一个会话的事件，不在 JS 里扫日志；不加迁移）。
 */
export class ConversationArtifacts {
  constructor(private readonly d: ConversationArtifactsDeps) {}

  async downloadUrl(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    artifactId: string,
  ): Promise<{ url: string; name: string }> {
    if (!UUID_RE.test(conversationId)) throw conversationNotFound();
    if (!(await this.d.isAccessible(orgId, conversationId, viewerAccountId))) {
      throw conversationNotFound();
    }
    if (!UUID_RE.test(artifactId)) throw artifactNotFound();
    const row = await this.d.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "artifact_created")
      .where(sql<string>`payload->>'artifactId'`, "=", artifactId)
      .limit(1)
      .executeTakeFirst();
    if (!row) throw artifactNotFound();
    const a = row.payload as EventPayload<"artifact_created">;
    const store = this.d.storage.kernel(orgId);
    if (!(await store.head(a.objectKey))) throw artifactNotFound();
    const url = await store.presignGet(a.objectKey, {
      ttlSeconds: ARTIFACT_DOWNLOAD_TTL_SECONDS,
      downloadName: a.name,
      disposition: "attachment",
      responseContentType: a.contentType,
    });
    return { url, name: a.name };
  }
}
