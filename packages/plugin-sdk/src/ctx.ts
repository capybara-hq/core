import type { Kysely } from "kysely";
import type { ExtensionPointRef } from "./extension-point.js";
import type { AvailableHook, HookHandler, HookOptions } from "./hooks.js";
import type { RouteCaller } from "./http-access.js";
import type { ModelEmbeddingInfo, ModelKind } from "./model.js";
import type { ExtensionNet } from "./net.js";
import type { SetupCheckDefinition } from "./setup-check.js";
import type { ObjectHead, PresignedUpload, PresignGetOptions } from "./storage.js";
import type { ToolHandler, ToolSpec } from "./tool.js";
import type { EmbedClaims, UiActionArgs, UiActionResult, UiRenderArgs, UiView } from "./ui.js";

/** Logger interface. */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Distributed lock lease. */
export interface Lease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * The plugin's object storage (`ctx.storage`, needs `permissions.storage`): the same shape as
 * `ObjectStore`, but the first parameter of every method is
 * `orgId`, and the kernel adds `plugins/<plugin name>/<orgId>/` to keys and prefixes automatically:
 * a plugin sees only its own objects under that org.
 * The backing store is the deployment-configured `object-store@1` provider; every method throws
 * when there is no provider.
 */
export interface ExtensionStorage {
  put(
    orgId: string,
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts: { contentType: string; size?: number; signal?: AbortSignal },
  ): Promise<ObjectHead>;
  /**
   * Returns null when missing. `range` is a closed byte range; an omitted `end` means read to the
   * end.
   * With `range`, `head.size` is still the size of the whole object; when the store ignores Range,
   * body may be the whole object.
   */
  get(
    orgId: string,
    key: string,
    opts?: { signal?: AbortSignal; range?: { start: number; end?: number } },
  ): Promise<{ head: ObjectHead; body: ReadableStream<Uint8Array> } | null>;
  head(orgId: string, key: string): Promise<ObjectHead | null>;
  /** A missing key also counts as success. */
  delete(orgId: string, key: string): Promise<void>;
  deletePrefix(orgId: string, prefix: string): Promise<number>;
  list(
    orgId: string,
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ObjectHead[]; cursor?: string }>;
  presignGet(orgId: string, key: string, opts: PresignGetOptions): Promise<string>;
  presignPut(
    orgId: string,
    key: string,
    opts: { contentType: string; maxSize: number; ttlSeconds: number },
  ): Promise<PresignedUpload>;
}

/** A `ctx.models.embed` request: texts embedded for one org with the model mapped to a purpose. */
export interface ExtensionEmbedRequest {
  orgId: string;
  /** A purpose this extension declared in `permissions.models` with `kind: "embedding"`. */
  purpose: string;
  /** The texts, one vector each; split into batches by the model's `maxBatch` by the kernel. */
  input: string[];
  /** One of the model's `embedding.dimensions`; the model's default when absent. */
  dimensions?: number;
  inputType?: "query" | "document";
  /**
   * Aborts this call (e.g. the tool call's `signal`); combined with `ctx.signal`. Batches not yet
   * sent are not sent; batches already answered are still recorded as usage.
   */
  signal?: AbortSignal;
}

/** A `ctx.models.embed` result. */
export interface ExtensionEmbedResult {
  /** One vector per input, in input order. */
  vectors: number[][];
  /** The model that made them (a changed model invalidates stored vectors). */
  model: { provider: string; id: string };
  dimensions: number;
}

/** The model a purpose maps to in an org (`ctx.models.describe`). */
export interface ExtensionModelTarget {
  provider: string;
  id: string;
  kind: ModelKind;
  /** Present for an embedding model. */
  embedding?: ModelEmbeddingInfo;
}

/**
 * Models by purpose (`permissions.models`): the purpose → model mapping is chosen by org admins
 * (and the deployment default by the super admin), never by the extension. Only purposes this
 * extension declared with `kind: "embedding"` are accepted (`model.purpose_unknown` otherwise), and
 * only for an org that enabled the extension (`extension.not_enabled`). Usage is recorded by the
 * kernel and reported through `usage.report` (purpose `embedding`).
 */
export interface ExtensionModels {
  /**
   * Embeds `input` with the org's effective model for `purpose`. Rejects with `model.unconfigured`
   * when the purpose maps to no model the org can use, `validation_failed` for dimensions the model
   * lacks, and a `ModelError` when the provider fails (a result of the wrong count or dimension is a
   * `ModelError` of kind `server`). Not retried by the kernel. Each call fires the `model.request`
   * hook first (`purpose: "embedding"`, every text of the call): when a policy hook denies it, the
   * call rejects with an error whose `code` is `model.hook_denied` (HTTP 403 if it escapes an
   * extension route), and nothing is sent or billed.
   */
  embed(req: ExtensionEmbedRequest): Promise<ExtensionEmbedResult>;
  /** The org's effective model for `purpose`, or null when it maps to no model the org can use. */
  describe(req: { orgId: string; purpose: string }): Promise<ExtensionModelTarget | null>;
}

/**
 * The context passed to a plugin's `setup`. It provides no timers or in-process shared state; kv
 * writes must carry a TTL.
 */
export interface ExtensionContext {
  kv: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, opts: { ttlSeconds: number }): Promise<void>;
    del(key: string): Promise<void>;
    incr(key: string, opts: { ttlSeconds: number }): Promise<number>;
  };
  lock: {
    acquire(key: string, opts: { ttlMs: number }): Promise<Lease | null>;
  };
  bus: {
    publish(topic: string, payload: unknown): Promise<void>;
    subscribe(topic: string, handler: (payload: unknown) => void): Promise<() => Promise<void>>;
  };
  queue: {
    define<T>(
      name: string,
      handler: (data: T) => Promise<void>,
      opts?: { concurrency?: number },
    ): void;
    add<T>(name: string, data: T, opts?: { delayMs?: number; jobId?: string }): Promise<void>;
  };
  secrets: {
    get(orgId: string, key: string): Promise<string | null>;
    set(orgId: string, key: string, value: string): Promise<void>;
  };
  /** Object storage (needs `permissions.storage`, see {@link ExtensionStorage}). */
  storage: ExtensionStorage;
  /** Models by purpose (requires `permissions.models`, see {@link ExtensionModels}). */
  models: ExtensionModels;
  /**
   * Guarded HTTP for URLs a person supplied (see {@link ExtensionNet}): a connector endpoint or an
   * org-overridable base URL goes through `ctx.net.fetch`, never the global `fetch`.
   */
  net: ExtensionNet;
  /** A Kysely instance already switched to this plugin's schema (withSchema). */
  // biome-ignore lint/suspicious/noExplicitAny: the plugin brings its own table structure, which the kernel cannot know statically
  db: Kysely<any>;
  http: {
    /**
     * Mounted at `/plugins/<name><path>` (`public`, `embed`) or `/plugins/<name>/orgs/:orgId<path>`
     * (`member`, `admin`), as `permissions.http` declares. The kernel enforces the access before
     * the handler runs and passes the resolved caller; trust only `caller`.
     */
    route(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      handler: (req: Request, caller: RouteCaller) => Promise<Response>,
    ): void;
  };
  tools: {
    /** Registers a tool; callable only during `setup`, names must not repeat. */
    register(spec: ToolSpec, handler: ToolHandler): void;
  };
  /**
   * Consume extension points provided by other extensions: only non-brokered refs declared in the
   * manifest's `requires` / `optional`. Without `orgId` it is the deployment-level view and returns
   * synchronously; with `orgId` it returns a Promise, and orgScoped extension points (such as
   * `channel`, `directory`) are filtered by that org's enablement (queried every time, not cached);
   * with `orgId`, a provider whose effective config is not valid in that org is excluded too;
   * `get` rejects with `ExtensionPointUnavailableError` when the provider is not enabled in that
   * org or its config is not valid there.
   * When there is no provider, `get` throws `ExtensionPointUnavailableError` and `list` returns an
   * empty list.
   */
  extensionPoints: {
    /** `provider` may be omitted for a single-select extension point; required for multi-select. */
    get<T>(ref: ExtensionPointRef, provider?: string): T;
    get<T>(
      ref: ExtensionPointRef,
      provider: string | undefined,
      opts: { orgId: string },
    ): Promise<T>;
    list<T>(ref: ExtensionPointRef): { plugin: string; impl: T }[];
    list<T>(
      ref: ExtensionPointRef,
      opts: { orgId: string },
    ): Promise<{ plugin: string; impl: T }[]>;
  };
  /**
   * Runtime of UI contributions (manifest `ui` + `permissions.ui`):
   * - `view` / `action`: can be registered only during `setup`; the id is the contribution id of
   *   the kind-view entry in the manifest;
   *   `action` receives a button click or form submission from the view (`args.actionId` tells
   * which one);
   * - `invalidate`: tells the kernel "this contribution changed", and the web pages that have it
   *   open fetch the view again (via the bus, across replicas); a
   *   `platform.page` contribution takes no `orgId` (it refreshes the admin console), every other
   *   contribution requires one;
   * - `verifyEmbedToken`: validates the embed token an embed page received; it accepts only
   *   tokens signed for this plugin and not expired, while the plugin is still enabled in that org,
   *   the caller is still an active member and the role still satisfies the slot's minRole,
   * otherwise it returns null; the returned `role` is the role at this moment. A
   *   platform-scope token (`scope: "platform"`, no `orgId`) verifies only for a `platform.page`
   *   contribution while the account is still an active super admin.
   */
  ui: {
    view(id: string, render: (args: UiRenderArgs) => Promise<UiView>): void;
    action(id: string, handler: (args: UiActionArgs) => Promise<UiActionResult>): void;
    invalidate(target: {
      /** Required, except for a `platform.page` contribution, where it must be omitted. */
      orgId?: string;
      conversationId?: string;
      contribution: string;
    }): Promise<void>;
    verifyEmbedToken(token: string): Promise<EmbedClaims | null>;
  };
  /**
   * Setup checks (`permissions.setupChecks`): the live rows of the plugin's setup guides.
   * `check` is only allowed during `setup`; `id` must be listed in `permissions.setupChecks`
   * (else `ExtensionPermissionError`); registering an id twice throws. The kernel runs a check only
   * when a person or an agent asks, only for targets of this plugin and of `def.place`, aborts
   * `signal` after `SETUP_CHECK_LIMITS.timeoutMs`, and redacts and bounds the result. A check never
   * writes, passes `signal` to every request, does not retry and never puts a secret in `reason`
   * or `fix`. It never receives an OAuth client secret or a member's token.
   */
  setup: {
    check(id: string, def: SetupCheckDefinition): void;
  };
  /**
   * Hooks (`permissions.hooks`): observe model and tool calls, or deny them with a policy hook.
   * `on` is only allowed during `setup`; the mount point must be declared in `permissions.hooks` and be
   * one of `HOOKS_AVAILABLE`; `mode: "policy"` only on `POLICY_HOOKS` and only for mount points also
   * declared in `permissions.policyHooks`. Hooks fire only for organizations
   * that enabled the plugin, only in chat conversations (never in eval replays); see `HookOptions` for
   * how policy and observe hooks run. Unloading, upgrading or disabling the plugin instance revokes
   * them (in-flight hook calls are drained like tool calls).
   */
  hooks: {
    on<K extends AvailableHook>(mount: K, handler: HookHandler<K>, opts: HookOptions): void;
  };
  provide(extensionPoint: ExtensionPointRef, impl: unknown): void;
  /**
   * The lifecycle signal of this plugin instance: aborted when the instance is revoked (disabled,
   * uninstalled, upgraded), after in-flight calls have drained.
   * Long-running tasks the plugin started itself (polling loops, long connections, etc.) wind down
   * on it.
   */
  signal: AbortSignal;
  /**
   * Deployment-level config, validated against the plugin schema (the startup config merged with
   * values the super admin saved in the console). This is a getter:
   * when a field marked `hot` (`.meta({ hot: true })`) changes, the kernel replaces it in place, so
   * the plugin must read `ctx.config` **at the time of use** to get the new value;
   * do not copy hot fields into a closure in setup; when a non-hot field changes the kernel reloads
   * the plugin instance (a new setup).
   */
  readonly config: unknown;
  log: Logger;
}
