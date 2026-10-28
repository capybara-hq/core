import {
  type ContentBlock,
  type ExtensionManifest,
  type ModelRequest,
  type ModelUsage,
  type ParamValue,
  type StopReason,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { paramIssues } from "../agents/agents.service.js";
import { ModelRef } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { estimateTokens } from "../runtime/context/tokens.js";
import { consumeModelStream } from "../runtime/model-call.js";
import { ProviderListError, type ProviderRegistry } from "../runtime/providers.js";

/**
 * 模型用途映射（C9）：内核与插件按「用途」取模型，不在代码里写死模型。
 * - 用途 = 内核用途 {@link KERNEL_PURPOSES}（目前只有评委 `eval`），或已加载插件 `permissions.models` 声明的；
 * - 映射 = 部署默认（`org_id` 为 null，企业管理员设）+ 组织覆盖（组织管理员设，`org.models.manage`）；
 *   生效的映射先取组织覆盖、再取部署默认，都没有 → `model.unconfigured`；
 * - 目标模型按部署范围解析（与运行时一致），参数按目标模型自己的声明严格校验；不做模型白名单；
 * - 每次都查 PG，不在进程内缓存（多副本下改映射立即生效）。`ctx.models` 仍预留，插件暂不能调用。
 */

/**
 * Purposes the kernel declares: the eval judge, and the three sub-agent model tiers (phase C,
 * spec §5.4: `fast` / `standard` / `capable` → `subagent_<tier>`; an unmapped tier runs on the
 * parent's model).
 */
export const KERNEL_PURPOSES = [
  { purpose: "eval", kind: "chat", label: { zh: "评测评委", en: "Eval judge" } },
  /** Conversation titles (UI refresh B); unmapped → the conversation's current chat model. */
  { purpose: "title", kind: "chat", label: { zh: "会话标题", en: "Conversation titles" } },
  {
    purpose: "subagent_fast",
    kind: "chat",
    label: { zh: "子代理：快速", en: "Sub-agent: fast" },
  },
  {
    purpose: "subagent_standard",
    kind: "chat",
    label: { zh: "子代理：标准", en: "Sub-agent: standard" },
  },
  {
    purpose: "subagent_capable",
    kind: "chat",
    label: { zh: "子代理：最强", en: "Sub-agent: capable" },
  },
] as const;

/** 一个用途映射到的模型与参数。 */
export interface PurposeTarget {
  model: ModelRef;
  params: Record<string, ParamValue>;
}

export interface PurposeView {
  purpose: string;
  kind: "chat" | "embedding";
  label: { zh: string; en: string };
  /** `kernel` 或声明它的插件名。 */
  declaredBy: string;
  default: PurposeTarget | null;
  override: PurposeTarget | null;
  effective: PurposeTarget | null;
}

/** `PUT …/model-purposes/:purpose` 的 body：设映射，或 `target: null` 清除。 */
export const PURPOSE_PUT = z
  .object({
    target: z
      .object({
        model: ModelRef.strict(),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PurposePut = z.infer<typeof PURPOSE_PUT>;

/**
 * 用途请求已经发出、但没有正常收完（出错、超时、中止）：`tokens` 是应计入预算的估算用量（输入估算 + 已流出字符 / 4，
 * 与评测回放一致），`cause` 是原始错误。请求发出之前的失败（未映射、模型不可用）原样抛出。
 */
export class PurposeAttemptError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly tokens: number,
    readonly provider: string,
    readonly model: string,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PurposeAttemptError";
  }
}

export interface ModelPurposesDeps {
  db: KernelSchemaDb;
  registry: Pick<ProviderRegistry, "resolve">;
  config: () => KernelConfig;
  /** 已加载插件的清单（取 `permissions.models`）。 */
  manifests: () => readonly ExtensionManifest[];
}

interface Declared {
  purpose: string;
  kind: "chat" | "embedding";
  label: { zh: string; en: string };
  declaredBy: string;
}

const unknownPurpose = (purpose: string) =>
  new ApiError("model.purpose_unknown", `Unknown model purpose "${purpose}"`);

const invalid = (details: { path: string; message: string }[]) =>
  new ApiError("validation_failed", "Invalid purpose target", details);

type Row = {
  org_id: string | null;
  purpose: string;
  provider: string;
  model: string;
  params: unknown;
};

const targetOf = (r: Row | undefined): PurposeTarget | null =>
  r === undefined
    ? null
    : {
        model: { provider: r.provider, model: r.model },
        params: (r.params ?? {}) as Record<string, ParamValue>,
      };

export class ModelPurposesService {
  constructor(private readonly d: ModelPurposesDeps) {}

  /** 全部已声明的用途：内核的在前，其后按插件加载顺序。 */
  private declared(): Declared[] {
    const out: Declared[] = KERNEL_PURPOSES.map((p) => ({
      purpose: p.purpose,
      kind: p.kind,
      label: { ...p.label },
      declaredBy: "kernel",
    }));
    const seen = new Set(out.map((p) => p.purpose));
    for (const m of this.d.manifests()) {
      for (const p of m.permissions?.models ?? []) {
        if (seen.has(p.purpose)) continue;
        seen.add(p.purpose);
        out.push({
          purpose: p.purpose,
          kind: p.kind,
          label: { zh: p.label.zh, en: p.label.en },
          declaredBy: m.name,
        });
      }
    }
    return out;
  }

  private find(purpose: string): Declared {
    const p = this.declared().find((x) => x.purpose === purpose);
    if (!p) throw unknownPurpose(purpose);
    return p;
  }

  private async rows(purposes: string[], orgId: string | undefined): Promise<Row[]> {
    if (purposes.length === 0) return [];
    return this.d.db
      .selectFrom("model_purpose_mappings")
      .select(["org_id", "purpose", "provider", "model", "params"])
      .where("purpose", "in", purposes)
      .where((eb) =>
        orgId === undefined
          ? eb("org_id", "is", null)
          : eb.or([eb("org_id", "is", null), eb("org_id", "=", orgId)]),
      )
      .execute();
  }

  private async views(decl: Declared[], orgId: string | undefined): Promise<PurposeView[]> {
    const rows = await this.rows(
      decl.map((p) => p.purpose),
      orgId,
    );
    return decl.map((p) => {
      const def = targetOf(rows.find((r) => r.purpose === p.purpose && r.org_id === null));
      const ovr =
        orgId === undefined
          ? null
          : targetOf(rows.find((r) => r.purpose === p.purpose && r.org_id === orgId));
      return { ...p, default: def, override: ovr, effective: ovr ?? def };
    });
  }

  /** 全部用途与映射；不给 `orgId` = 部署级视图（`override` 一律为 null）。 */
  async list(orgId?: string): Promise<PurposeView[]> {
    return this.views(this.declared(), orgId);
  }

  /** 校验目标：模型可解析（部署范围）、参数按它的声明严格通过。 */
  private async check(target: PurposeTarget): Promise<void> {
    let info: Awaited<ReturnType<ProviderRegistry["resolve"]>>["info"];
    try {
      ({ info } = await this.d.registry.resolve(target.model));
    } catch (e) {
      if (e instanceof ProviderListError) throw e;
      if (e instanceof ApiError && e.code === "agent.model_unavailable") {
        throw invalid([{ path: "target.model", message: "model is not available" }]);
      }
      throw e;
    }
    const issues = paramIssues("target.params", info.parameters, target.params);
    if (issues.length > 0) throw invalid(issues);
  }

  private async set(
    orgId: string | null,
    purpose: string,
    target: PurposeTarget | null,
    actor: string,
    actorTokenId: string | undefined,
  ): Promise<PurposeView> {
    const decl = this.find(purpose);
    if (target) await this.check(target);
    await this.d.db.transaction().execute(async (trx) => {
      if (orgId === null) await lockEnterpriseAdminsAndAuthorize(trx, actor);
      else await lockOrgAndAuthorize(trx, orgId, actor, "org.models.manage");
      if (target === null) {
        await trx
          .deleteFrom("model_purpose_mappings")
          .where("purpose", "=", purpose)
          .where((eb) => (orgId === null ? eb("org_id", "is", null) : eb("org_id", "=", orgId)))
          .execute();
      } else {
        const values = {
          provider: target.model.provider,
          model: target.model.model,
          params: JSON.stringify(target.params),
          updated_by: actor,
        };
        await trx
          .insertInto("model_purpose_mappings")
          .values({ org_id: orgId, purpose, ...values })
          .onConflict((oc) =>
            oc
              .constraint("model_purpose_mappings_scope_key")
              .doUpdateSet({ ...values, updated_at: new Date() }),
          )
          .execute();
      }
      await audit(trx, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        ...(orgId !== null && { orgId }),
        action: "model.purpose_mapped",
        target: purpose,
        detail: { scope: orgId === null ? "deployment" : "org", target },
      });
    });
    const [view] = await this.views([decl], orgId ?? undefined);
    return view as PurposeView;
  }

  /** 设置（或 `null` 清除）部署默认；只有企业管理员（事务内复核）。 */
  setDefault(
    purpose: string,
    target: PurposeTarget | null,
    actor: string,
    actorTokenId?: string,
  ): Promise<PurposeView> {
    return this.set(null, purpose, target, actor, actorTokenId);
  }

  /** 设置（或 `null` 清除）组织覆盖；事务内锁组织并复核 `org.models.manage`。 */
  setOrg(
    orgId: string,
    purpose: string,
    target: PurposeTarget | null,
    actor: string,
    actorTokenId?: string,
  ): Promise<PurposeView> {
    return this.set(orgId, purpose, target, actor, actorTokenId);
  }

  /** 生效的映射：组织覆盖，否则部署默认；都没有 → `model.unconfigured`；用途未声明 → `model.purpose_unknown`。 */
  async resolve(orgId: string, purpose: string): Promise<PurposeTarget> {
    const [view] = await this.views([this.find(purpose)], orgId);
    if (!view?.effective) {
      throw new ApiError(
        "model.unconfigured",
        `No model is configured for the "${purpose}" purpose`,
      );
    }
    return view.effective;
  }

  /**
   * 按用途发一次对话请求：解析映射、按目标模型的声明宽松处理参数（补默认值，与运行时一致），用 `consumeModelStream`
   * 收完（只有流空闲看门狗）。输出上限取 `min(req.maxOutputTokens, 目标模型的 maxOutputTokens)`。
   * 请求发出之前的失败原样抛出；发出之后的失败包成 {@link PurposeAttemptError}（带估算用量）。
   * `opts.fallback`: the target used when the purpose is not mapped (`model.unconfigured`).
   * `opts.beforeSend`: called with the resolved target and the final request just before sending;
   * what it throws is thrown as is (a pre-send failure, e.g. a denied `model.request` hook).
   */
  async chat(
    orgId: string,
    purpose: string,
    req: Omit<ModelRequest, "model" | "params">,
    signal: AbortSignal,
    opts: {
      fallback?: PurposeTarget;
      beforeSend?: (target: ModelRef, request: ModelRequest) => Promise<void>;
    } = {},
  ): Promise<{
    content: ContentBlock[];
    stopReason: StopReason;
    usage: ModelUsage;
    provider: string;
    model: string;
  }> {
    let target: PurposeTarget;
    try {
      target = await this.resolve(orgId, purpose);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "model.unconfigured") || !opts.fallback) throw e;
      target = opts.fallback;
    }
    const { provider, info } = await this.d.registry.resolve(target.model);
    const request: ModelRequest = {
      ...req,
      model: info.id,
      params: sanitizeParams(info.parameters, target.params).value,
      // 输出上限不超过目标模型自己的上限（与运行时 assembleModelRequest 一致）
      maxOutputTokens: Math.min(req.maxOutputTokens, info.maxOutputTokens),
    };
    const idleMs = info.streamIdleTimeoutMs ?? this.d.config().runtime.streamIdleMs;
    await opts.beforeSend?.(target.model, request);
    let chars = 0;
    try {
      const out = await consumeModelStream(provider, request, idleMs, signal, (ev) => {
        chars += ev.text.length;
      });
      return {
        content: out.content,
        stopReason: out.stopReason,
        usage: out.usage,
        provider: target.model.provider,
        model: target.model.model,
      };
    } catch (err) {
      const tokens =
        estimateTokens(request.messages, request.system, request.tools) + Math.ceil(chars / 4);
      throw new PurposeAttemptError(err, tokens, target.model.provider, target.model.model);
    }
  }
}
