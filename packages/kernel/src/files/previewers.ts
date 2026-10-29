import {
  FILE_PREVIEW_EXTENSION_POINT,
  type FilePreviewer,
  type FilePreviewProvider,
  type Logger,
  previewerAccepts,
  type UiView,
  validateUiView,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ConversationFiles } from "../conversations/files.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionHost } from "../extensions/host.js";
import type { InflightTracker } from "../extensions/inflight.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { StorageService } from "../storage/storage.service.js";
import { callExtension } from "../ui/call-extension.js";

/** Time limit of a previewer's render (UI refresh spec §5.3: 10 s on the conversation page). */
export const FILE_PREVIEW_TIMEOUT_MS = 10_000;

/** A previewer that takes a file, as listed for the conversation page. */
export interface PreviewerItem {
  plugin: string;
  id: string;
  title: { zh: string; en: string };
  kind: "view" | "embed";
  /** The most bytes the previewer takes: the web caps what it posts to an embed at this. */
  maxBytes: number;
}

/** A previewer in the org's order (the admin list). */
export interface OrgPreviewerItem extends PreviewerItem {
  accepts: FilePreviewer["accepts"];
  maxBytes: number;
  position: number;
  disabled: boolean;
}

interface PreviewerRegistryDeps {
  /** The context-aware handle (the `@Transactional` method's transaction, else the pool). */
  readonly db: KernelSchemaDb;
  host: Pick<ExtensionHost, "list">;
  /** Extensions enabled in the org (queried every time). */
  enabledPlugins(orgId: string): Promise<Set<string>>;
  files: Pick<ConversationFiles, "file">;
  storage: Pick<StorageService, "kernel">;
  log: Pick<Logger, "warn">;
}

interface Loaded {
  plugin: string;
  previewer: FilePreviewer;
  inflight: InflightTracker;
}

const notFound = () => new ApiError("ui.not_found", "Previewer not found");

const item = (l: Loaded): PreviewerItem => ({
  plugin: l.plugin,
  id: l.previewer.id,
  title: { zh: l.previewer.title.zh, en: l.previewer.title.en },
  kind: l.previewer.embed !== undefined ? "embed" : "view",
  maxBytes: l.previewer.maxBytes,
});

/** Reads a stream into one buffer; more than `max` bytes → throws (the grant's cap). */
async function readAtMost(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) throw new Error(`the file is larger than this previewer's maxBytes (${max})`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * `file-preview@1` (UI refresh spec §5.8): which previewers take a file, in the org's order
 * (`capybara.file_previewers` rows first by position, then the rest in provider order; disabled ones
 * dropped; only extensions enabled in the org), and rendering a view previewer through a read grant
 * for that one file (valid only during the call, capped at the previewer's `maxBytes`; the extension
 * never gets a storage key or URL). Providers are validated when they are provided (`ctx.provide`).
 * No state across requests.
 */
@Injectable()
export class PreviewerRegistry {
  /** Default {@link FILE_PREVIEW_TIMEOUT_MS} (tests set less). */
  timeoutMs = FILE_PREVIEW_TIMEOUT_MS;
  private readonly d: PreviewerRegistryDeps;

  constructor(
    @Inject(KernelDb) kdb: Pick<KernelDb, "db">,
    @Inject(ExtensionHost) host: Pick<ExtensionHost, "list" | "enabledPlugins">,
    @Inject(ConversationFiles) files: Pick<ConversationFiles, "file">,
    @Inject(StorageService) storage: Pick<StorageService, "kernel">,
    @Inject(KERNEL_LOGGER) log: Pick<Logger, "warn">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {
    this.d = {
      get db(): KernelSchemaDb {
        return kdb.db;
      },
      host,
      enabledPlugins: (orgId) => host.enabledPlugins(orgId),
      files,
      storage,
      log,
    };
  }

  /** Every previewer loaded on this replica, in provider order (load order, then list order). */
  private loaded(): Loaded[] {
    return this.d.host
      .list("file-preview")
      .filter((e) => e.capability === FILE_PREVIEW_EXTENSION_POINT)
      .flatMap((e) =>
        (e.impl as FilePreviewProvider).previewers.map((previewer) => ({
          plugin: e.plugin,
          previewer,
          inflight: e.inflight,
        })),
      );
  }

  /** The org's previewers (enabled extensions only) in its order, disabled ones included. */
  private async ordered(orgId: string): Promise<(Loaded & { disabled: boolean })[]> {
    const enabled = await this.d.enabledPlugins(orgId);
    const loaded = this.loaded().filter((l) => enabled.has(l.plugin));
    if (loaded.length === 0) return [];
    const rows = await this.d.db
      .selectFrom("file_previewers")
      .select(["plugin", "previewer_id", "position", "disabled"])
      .where("org_id", "=", orgId)
      .execute();
    const rowOf = new Map(rows.map((r) => [`${r.plugin}/${r.previewer_id}`, r]));
    const keyed = loaded.map((l, i) => {
      const r = rowOf.get(`${l.plugin}/${l.previewer.id}`);
      return { l, r, i };
    });
    keyed.sort((a, b) => {
      if (a.r && b.r) return a.r.position - b.r.position || a.i - b.i;
      if (a.r) return -1;
      if (b.r) return 1;
      return a.i - b.i;
    });
    return keyed.map(({ l, r }) => ({ ...l, disabled: r?.disabled ?? false }));
  }

  /** The admin list: every previewer of the org's enabled extensions, in order. */
  async list(orgId: string): Promise<OrgPreviewerItem[]> {
    return (await this.ordered(orgId)).map((l, position) => ({
      ...item(l),
      accepts: l.previewer.accepts,
      position,
      disabled: l.disabled,
    }));
  }

  /**
   * Sets the org's order: `items` first in the given order (with their `disabled`), the rest after
   * them in provider order. An item naming no previewer of an enabled extension, or named twice →
   * 400 `validation_failed`. Only rows of previewers this replica knows are replaced: rows of an
   * extension that is disabled now (or not loaded here yet) keep their order and `disabled`.
   * Audited as `org.file_previewers.updated`.
   */
  async put(
    orgId: string,
    items: { plugin: string; id: string; disabled: boolean }[],
    actor: { accountId?: string; tokenId?: string } = {},
  ): Promise<OrgPreviewerItem[]> {
    const known = new Set((await this.ordered(orgId)).map((l) => `${l.plugin}/${l.previewer.id}`));
    const seen = new Set<string>();
    for (const i of items) {
      const k = `${i.plugin}/${i.id}`;
      if (!known.has(k) || seen.has(k)) {
        throw new ApiError(
          "validation_failed",
          `${k} is not a previewer of an extension enabled in this organization, or is listed twice`,
        );
      }
      seen.add(k);
    }
    await this.putIn(orgId, items, known, actor);
    return this.list(orgId);
  }

  /** Replaces the org's rows of the previewers this replica knows, in one transaction. */
  @Transactional({ propagation: "requires_new" })
  private async putIn(
    orgId: string,
    items: { plugin: string; id: string; disabled: boolean }[],
    known: Set<string>,
    actor: { accountId?: string; tokenId?: string },
  ): Promise<void> {
    if (known.size > 0) {
      await this.d.db
        .deleteFrom("file_previewers")
        .where("org_id", "=", orgId)
        .where(sql<string>`plugin || '/' || previewer_id`, "in", [...known])
        .execute();
    }
    if (items.length > 0) {
      await this.d.db
        .insertInto("file_previewers")
        .values(
          items.map((i, position) => ({
            org_id: orgId,
            plugin: i.plugin,
            previewer_id: i.id,
            position,
            disabled: i.disabled,
          })),
        )
        .execute();
    }
    await audit(this.d.db, {
      ...(actor.accountId !== undefined && { actorAccountId: actor.accountId }),
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId,
      action: "org.file_previewers.updated",
      detail: { items },
    });
  }

  /** Previewers that take this file (viewer must read the conversation), in the org's order. */
  async forFile(
    orgId: string,
    conversationId: string,
    viewer: string,
    fileId: string,
  ): Promise<PreviewerItem[]> {
    const file = await this.d.files.file(orgId, conversationId, viewer, fileId);
    return (await this.accepting(orgId, file)).map(item);
  }

  private async accepting(
    orgId: string,
    file: { name: string; contentType: string; size: number },
  ): Promise<Loaded[]> {
    return (await this.ordered(orgId)).filter(
      (l) => !l.disabled && previewerAccepts(l.previewer, file),
    );
  }

  /**
   * Renders a view previewer for one file: 404 `ui.not_found` when it does not take the file (or is
   * disabled, not enabled, an embed); the render's errors as for plugin views (504 / 502).
   */
  async render(t: {
    orgId: string;
    accountId: string;
    conversationId: string;
    fileId: string;
    plugin: string;
    id: string;
    locale: "zh" | "en";
  }): Promise<UiView> {
    const file = await this.d.files.file(t.orgId, t.conversationId, t.accountId, t.fileId);
    const l = (await this.accepting(t.orgId, file)).find(
      (x) => x.plugin === t.plugin && x.previewer.id === t.id,
    );
    const render = l?.previewer.render;
    if (!l || render === undefined) throw notFound();
    const maxBytes = l.previewer.maxBytes;
    const store = this.d.storage.kernel(t.orgId);
    let open = true;
    const expired = () => new Error("the file read grant has expired");
    const fields = { plugin: t.plugin, previewer: t.id, orgId: t.orgId };
    let view: UiView;
    // The grant ends when the kernel stops waiting (return, throw, timeout, unload), whether or not
    // the render has settled; read() also refuses once its signal aborted, since an object store
    // need not honour an already-aborted signal.
    try {
      view = await callExtension({
        log: this.d.log,
        plugin: t.plugin,
        what: "file preview",
        fields,
        timeoutMs: this.timeoutMs,
        failCode: "ui.render_failed",
        failMessage: `Plugin ${t.plugin} failed to preview the file with ${t.id}`,
        fn: (signal) =>
          l.inflight.run(signal, async (s) => {
            try {
              return await render.call(l.previewer, {
                orgId: t.orgId,
                accountId: t.accountId,
                conversationId: t.conversationId,
                locale: t.locale,
                signal: s,
                file: {
                  id: file.id,
                  name: file.name,
                  contentType: file.contentType,
                  size: file.size,
                },
                read: async () => {
                  if (!open || s.aborted) throw expired();
                  if (file.size > maxBytes) {
                    throw new Error(
                      `the file is larger than this previewer's maxBytes (${maxBytes})`,
                    );
                  }
                  const got = await store.get(file.objectKey, { signal: s });
                  if (!got) throw new Error("the file is no longer available");
                  if (!open || s.aborted) {
                    await got.body.cancel().catch(() => {});
                    throw expired();
                  }
                  const bytes = await readAtMost(got.body, maxBytes);
                  if (!open || s.aborted) throw expired();
                  return bytes;
                },
              });
            } finally {
              open = false;
            }
          }),
      });
    } finally {
      open = false;
    }
    const problems = validateUiView(view);
    if (problems.length > 0) {
      this.d.log.warn("file previewer returned an invalid view", {
        ...fields,
        problems: problems.slice(0, 10),
      });
      throw new ApiError("ui.invalid_view", `Plugin ${t.plugin} returned an invalid view`);
    }
    return view;
  }

  /**
   * Whether an embed token for a `file-preview` contribution may be issued for this file: the
   * viewer reads the conversation, the file is in it, and an enabled previewer of that extension
   * with `embed: contribution` takes it. Conversation / file not found throws 404.
   */
  async embedAllowed(t: {
    orgId: string;
    accountId: string;
    conversationId: string;
    fileId: string;
    plugin: string;
    contribution: string;
  }): Promise<boolean> {
    const file = await this.d.files.file(t.orgId, t.conversationId, t.accountId, t.fileId);
    return (await this.accepting(t.orgId, file)).some(
      (l) => l.plugin === t.plugin && l.previewer.embed === t.contribution,
    );
  }
}
