import {
  FILE_PREVIEW_EXTENSION_POINT,
  type FilePreviewer,
  type FilePreviewProvider,
  type Logger,
  previewerAccepts,
  type UiView,
  validateUiView,
} from "@capybara-hq/plugin-sdk";
import type { ConversationFiles } from "../conversations/files.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { InflightTracker } from "../extensions/inflight.js";
import type { StorageService } from "../storage/storage.service.js";
import { callExtension } from "../ui/views.js";

/** Time limit of a previewer's render (UI refresh spec §5.3: 10 s on the conversation page). */
export const FILE_PREVIEW_TIMEOUT_MS = 10_000;

/** A previewer that takes a file, as listed for the conversation page. */
export interface PreviewerItem {
  plugin: string;
  id: string;
  title: { zh: string; en: string };
  kind: "view" | "embed";
}

/** A previewer in the org's order (the admin list). */
export interface OrgPreviewerItem extends PreviewerItem {
  accepts: FilePreviewer["accepts"];
  maxBytes: number;
  position: number;
  disabled: boolean;
}

export interface PreviewerRegistryDeps {
  db: KernelDb;
  host: Pick<ExtensionHost, "list">;
  /** Extensions enabled in the org (queried every time). */
  enabledPlugins(orgId: string): Promise<Set<string>>;
  files: Pick<ConversationFiles, "file">;
  storage: Pick<StorageService, "kernel">;
  log: Pick<Logger, "warn">;
  /** Default {@link FILE_PREVIEW_TIMEOUT_MS}. */
  timeoutMs?: number;
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
 * Not Nest-dependent; no state across requests.
 */
export class PreviewerRegistry {
  private readonly timeoutMs: number;

  constructor(private readonly d: PreviewerRegistryDeps) {
    this.timeoutMs = d.timeoutMs ?? FILE_PREVIEW_TIMEOUT_MS;
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
      maxBytes: l.previewer.maxBytes,
      position,
      disabled: l.disabled,
    }));
  }

  /**
   * Sets the org's order: `items` first in the given order (with their `disabled`), the rest after
   * them in provider order. An item naming no previewer of an enabled extension, or named twice →
   * 400 `validation_failed`.
   */
  async put(
    orgId: string,
    items: { plugin: string; id: string; disabled: boolean }[],
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
    await this.d.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("file_previewers").where("org_id", "=", orgId).execute();
      if (items.length > 0) {
        await trx
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
    });
    return this.list(orgId);
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
    const view = await callExtension({
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
                if (!open) throw expired();
                if (file.size > maxBytes) {
                  throw new Error(
                    `the file is larger than this previewer's maxBytes (${maxBytes})`,
                  );
                }
                const got = await store.get(file.objectKey, { signal: s });
                if (!got) throw new Error("the file is no longer available");
                const bytes = await readAtMost(got.body, maxBytes);
                if (!open) throw expired();
                return bytes;
              },
            });
          } finally {
            open = false;
          }
        }),
    });
    // the grant also ends when the kernel stops waiting (timeout)
    open = false;
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
