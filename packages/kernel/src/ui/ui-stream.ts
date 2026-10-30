import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ApiError, type ErrorCode } from "../errors.js";
import type { CredentialCheck } from "../identity/credential-check.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { GracefulShutdown } from "../infra/lifecycle/graceful-shutdown.service.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import {
  endedStream,
  type SseOutput,
  type StreamBus,
  type StreamHandle,
} from "../runtime/stream.js";
import { isUiBusMessage, orgUiTopic, PAGE_MIN_ROLE, uiFrame } from "./registry.js";

interface OrgUiStreamsDeps {
  bus: StreamBus;
  /**
   * 调用者此刻的组织角色（组织未删除、账号 active、仍有成员关系，否则 undefined）：
   * 连接建立时与每 `sseRecheckMs` 复核一次；组织级刷新只服务组织页面，要 member 以上（A38）。
   */
  memberRole(orgId: string, accountId: string): Promise<OrgRole | undefined>;
  config: Pick<KernelConfigService, "get">;
  log: Pick<Logger, "warn">;
}

export interface OrgUiStreamParams {
  orgId: string;
  viewerAccountId: string;
  credential: CredentialCheck;
}

/** The org role the org UI stream re-checks. */
@Injectable()
export class UiStreamMembership {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /** 组织成员角色（一条查询）：组织未删除、账号 active、仍有成员关系。 */
  async role(orgId: string, accountId: string): Promise<OrgRole | undefined> {
    const row = await this.db
      .selectFrom("memberships")
      .innerJoin("orgs", "orgs.id", "memberships.org_id")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("memberships.role")
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "=", accountId)
      .where("orgs.deleted_at", "is", null)
      .where("accounts.status", "=", "active")
      .executeTakeFirst();
    return row?.role;
  }
}

async function authorize(d: OrgUiStreamsDeps, p: OrgUiStreamParams): Promise<ErrorCode | null> {
  const denied = await p.credential();
  if (denied !== null) return denied;
  const role = await d.memberRole(p.orgId, p.viewerAccountId);
  if (role === undefined) return "org.not_found";
  return roleAtLeast(role, PAGE_MIN_ROLE) ? null : "ui.not_found";
}

/** 慢客户端的积压上限（刷新帧很小，超过即说明客户端不读了）。 */
const MAX_BACKLOG_BYTES = 1024 * 1024;

/**
 * 组织级界面刷新流（SSE）：订阅内核主题 `org-ui.<orgId>`，把插件 `ctx.ui.invalidate`（不带对话）的刷新
 * 转发为 `event: ui`（`data: {"plugin","contribution"}`）。跨副本只经 Redis bus；进程内只持有连接本身的资源
 * （订阅、心跳与复核定时器），停机时一并关闭。
 */
@Injectable()
export class OrgUiStreams {
  private readonly active = new Set<OrgUiConnection>();
  /** Set by {@link closeAll}: streams opened afterwards end as soon as they begin. */
  private closing = false;
  private readonly d: OrgUiStreamsDeps;

  /**
   * Closes the streams when the shutdown begins (readiness answers 503 from that moment) and
   * latches: streams opened afterwards end at once, so the HTTP phase of the stop never waits on
   * an event stream. Without `GracefulShutdown` (a standalone HTTP application, tests only) the
   * streams end with their connections.
   */
  constructor(
    @Inject(KERNEL_BUS) bus: StreamBus,
    @Inject(UiStreamMembership) membership: Pick<UiStreamMembership, "role">,
    @Inject(KernelConfigService) config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) log: Pick<Logger, "warn">,
    @Optional() @Inject(GracefulShutdown) shutdown?: Pick<GracefulShutdown, "signal">,
  ) {
    this.d = {
      bus,
      memberRole: (orgId, accountId) => membership.role(orgId, accountId),
      config,
      log,
    };
    if (shutdown?.signal.aborted) this.closeAll();
    else shutdown?.signal.addEventListener("abort", () => this.closeAll(), { once: true });
  }

  /** 复核凭据与成员关系并订阅；失败时尚未写响应，调用方按普通错误返回。 */
  async open(p: OrgUiStreamParams, out: SseOutput): Promise<StreamHandle> {
    const denied = await authorize(this.d, p);
    if (denied !== null) throw new ApiError(denied, "Access denied");
    if (this.closing) return endedStream(out);
    const conn = new OrgUiConnection(this.d, p, out, () => this.active.delete(conn));
    this.active.add(conn);
    try {
      await conn.subscribe();
    } catch (e) {
      conn.close();
      throw e;
    }
    if (this.closing) {
      conn.close();
      return endedStream(out);
    }
    return conn;
  }

  /** Closes every stream of this process (at shutdown) and latches, like `ConversationStreams`. */
  closeAll(): void {
    this.closing = true;
    for (const c of [...this.active]) c.close();
  }

  get size(): number {
    return this.active.size;
  }
}

class OrgUiConnection implements StreamHandle {
  private closed = false;
  private begun = false;
  private rechecking = false;
  private unsubscribe: (() => Promise<void>) | undefined;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly d: OrgUiStreamsDeps,
    private readonly p: OrgUiStreamParams,
    private readonly out: SseOutput,
    private readonly onClosed: () => void,
  ) {}

  async subscribe(): Promise<void> {
    const un = await this.d.bus.subscribe(orgUiTopic(this.p.orgId), (m) => {
      // begin() 之前（响应头还没写）到达的刷新丢掉：网页连上后会先取一次视图
      if (this.begun && isUiBusMessage(m)) this.write(uiFrame(m));
    });
    if (this.closed) await un();
    else this.unsubscribe = un;
  }

  begin(): void {
    if (this.closed) return;
    this.begun = true;
    const { sseHeartbeatMs, sseRecheckMs } = this.d.config.get().runtime;
    this.timers.push(
      setInterval(() => this.write(": ping\n\n"), sseHeartbeatMs),
      setInterval(() => void this.recheck(), sseRecheckMs),
    );
  }

  close(mode: "end" | "abort" = "end"): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const un = this.unsubscribe;
    this.unsubscribe = undefined;
    un?.().catch((err) =>
      this.d.log.warn("org ui stream unsubscribe failed", { orgId: this.p.orgId, err }),
    );
    if (this.begun) {
      try {
        if (mode === "abort") this.out.abort();
        else this.out.end();
      } catch {
        // 连接已断开
      }
    }
    this.onClosed();
  }

  private write(chunk: string): void {
    if (this.closed) return;
    try {
      this.out.write(chunk);
    } catch {
      this.close("abort");
      return;
    }
    if (this.out.backlog() > MAX_BACKLOG_BYTES) {
      this.d.log.warn("org ui stream client too slow; closing", { orgId: this.p.orgId });
      this.close("abort");
    }
  }

  /** 复核凭据与成员关系；失败时发最后一帧 `event: error`（`data: {"code"}`）再关闭。 */
  private async recheck(): Promise<void> {
    if (this.closed || this.rechecking) return;
    this.rechecking = true;
    let code: ErrorCode | null;
    try {
      code = await authorize(this.d, this.p);
    } catch (err) {
      this.d.log.warn("org ui stream access re-check failed; closing", {
        orgId: this.p.orgId,
        err,
      });
      code = "internal";
    } finally {
      this.rechecking = false;
    }
    if (code === null || this.closed) return;
    this.write(`event: error\ndata: ${JSON.stringify({ code })}\n\n`);
    this.close();
  }
}
