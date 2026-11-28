import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { FileCreateBody, FileIdParams, LibraryListQuery } from "../../files/library.schemas.js";
import { FileBlobClaimedError, LibraryFilesService } from "../../files/library-files.service.js";
import { type LibraryFileView, LibraryQuery } from "../../files/library-query.js";
import { FileRefSchema } from "../file-ref.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { named, orElse } from "./summary.js";

const PAGE = 50;
const FileId = FileIdParams.shape.id;

/** A list row: the compact form of a library entry. */
const row = (f: LibraryFileView) => ({
  id: f.id,
  name: f.name,
  contentType: f.contentType,
  size: f.size,
  origin: f.origin,
  ...(f.agentName !== undefined && { agent: f.agentName }),
  ...(f.sourceConversation !== null && {
    conversation: {
      id: f.sourceConversation.id,
      title: f.sourceConversation.title,
      ...(f.sourceConversation.deleted && { deleted: true }),
    },
  }),
  versionCount: f.versions,
  createdAt: f.createdAt,
});

/** Model-visible: the bytes' blob kept being deleted while the file was added (a transient race). */
const BLOB_CLAIMED_TEXT =
  "The stored bytes were being cleaned up while the file was added, and nothing was added; call the operation again.";

/** The link of one file on the Files page. */
const fileLink = (id: string) => `/files#item=${encodeURIComponent(id)}`;

/**
 * File library operations of the `Platform` tool (file library spec §6, §8): the person's own
 * files, as the Files page shows them. Bytes, previews and the HTML document stay with the web
 * (`transport` exclusions); deleting a file is confirmed by the person on the Files page, so
 * `files.delete` only checks the file and hands them the link. `files.add` is the upload routes
 * with a file reference in place of the bytes (platform web parity spec §5).
 */
@Injectable()
export class FilesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(LibraryQuery) private readonly library: LibraryQuery,
    @Inject(LibraryFilesService) private readonly files: LibraryFilesService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "files.list",
        description:
          "List your files (the Files page), newest first: files you uploaded and files agents delivered or generated in your conversations, each with id, name, type, size, origin, the agent and the conversation it came from (deleted conversations keep their files) and the number of versions as versionCount (repeated deliveries of one path in one conversation are one entry). Filter by origin, agentId, type (image, document, text, other) or q (part of the name). Pages by 50: pass the returned next as params.cursor.",
        input: LibraryListQuery.pick({
          origin: true,
          agentId: true,
          type: true,
          q: true,
          cursor: true,
        }).strict(),
        example: { q: "report" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/files"],
        // the page size is fixed at 50
        omits: ["limit"],
        errors: [
          {
            code: "validation_failed",
            next: "Pass the next value of the previous page as params.cursor, unchanged.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) => {
          const out = await this.library.list(ctx.orgId, ctx.actorAccountId, {
            limit: PAGE,
            ...(input.origin !== undefined && { origin: input.origin }),
            ...(input.agentId !== undefined && { agentId: input.agentId }),
            ...(input.type !== undefined && { type: input.type }),
            ...(input.q !== undefined && { q: input.q }),
            ...(input.cursor !== undefined && { cursor: input.cursor }),
          });
          return { files: out.files.map(row), next: out.next };
        },
      }),
      defineOperation({
        id: "files.get",
        description:
          "Read one of your files: its details, your conversations it was sent or delivered in, and its versions (newest first). Takes the id from files.list. File contents are opened on the web.",
        input: z.object({ fileId: FileId }).strict(),
        example: { fileId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/files/:id"],
        renames: { fileId: "id" },
        errors: [
          {
            code: "file.not_found",
            next: "Check the id with files.list: only your own files can be read.",
          },
        ],
        confirm: "read",
        run: async (input, ctx) => {
          const d = await this.library.details(ctx.orgId, ctx.actorAccountId, input.fileId);
          return { file: row(d.file), conversations: d.conversations, versions: d.versions };
        },
      }),
      defineOperation({
        id: "files.usage",
        description:
          "Read how much storage your files use: the number of your files and their bytes (a file stored twice counts once).",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/files/usage"],
        confirm: "read",
        run: async (_input, ctx) => this.library.usage(ctx.orgId, ctx.actorAccountId),
      }),
      defineOperation({
        id: "files.add",
        description:
          "Add a file of this conversation to your files (the Files page) as your own upload: an attachment, a generated image, an image a tool showed you or a delivered file, passed as file: { fileId } (Deliver a device file first). A file has one owner: a file of another person's files is refused (they add it themselves). name names the new entry (default: the file's name). A file that already is one of your files is returned as it is (with a different name, a renamed entry is added next to it), and so is your file of the same name and bytes: nothing is added twice. Bytes the org already stores are not stored again. Only the types and sizes the composer accepts can be added. The person sees the file on the card. Returns the entry's id, name, size and content type, and added: false when it was already there.",
        input: z
          .object({ file: FileRefSchema, name: FileCreateBody.shape.name.optional() })
          .strict(),
        example: { file: { fileId: "0b9f2c4e-1d3a-4c55-9e0a-7a2f6d1c8b11" } },
        authz: { orgAction: "agents.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/files", "POST /api/v1/orgs/:orgId/files/:id/finalize"],
        // the upload registration's fields come from the referenced file (its type, size and
        // sha256, a library upload); the kernel adds the bytes it holds, so there is no upload to
        // finalize and no id to pass
        omits: ["contentType", "size", "sha256", "purpose", "id"],
        extras: ["file"],
        loosens: { name: "optional: the referenced file's name is the default" },
        confirm: "personal",
        errors: [
          {
            code: "file.type_not_allowed",
            next: "This type of file cannot be added to the Files page (or its bytes are not of its type); tell the person, or convert it to an accepted type, deliver it and retry.",
          },
          {
            code: "file.too_large",
            next: "The file is over the upload limit; tell the person, or make it smaller, deliver it and retry.",
          },
          {
            code: "storage.unavailable",
            next: "File storage is unavailable; try again later, or tell the person to contact the super admin.",
          },
        ],
        // the upload's types, signature and per-type size, and one owner per file, are checked
        // before the card (and again before the run)
        fileRef: (i) => {
          const limits = this.files.limits();
          return {
            ref: i.file,
            limits: {
              maxBytes: Math.max(limits.maxBytes, limits.imageMaxBytes),
              contentTypes: limits.types,
              typeMaxBytes: Object.fromEntries(
                limits.types.map((t) => [t, this.files.limitFor(t)]),
              ),
              ownFilesOnly: true,
            },
          };
        },
        summary: async (i, ctx) => {
          const f = named(ctx.file?.name ?? "?");
          const own = await orElse(
            async () => (await this.files.ownerOf(ctx.orgId, i.file.fileId)) === ctx.actorAccountId,
            false,
          );
          const renamed = i.name !== undefined && i.name !== ctx.file?.name;
          if (own && !renamed) {
            return {
              zh: `文件「${f}」已在你的文件中，不会重复添加`,
              en: `The file "${f}" is already in your files; nothing is added`,
            };
          }
          return renamed
            ? {
                zh: `把文件「${f}」以「${named(i.name ?? "")}」为名加入你的文件`,
                en: `Add the file "${f}" to your files as "${named(i.name ?? "")}"`,
              }
            : { zh: `把文件「${f}」加入你的文件`, en: `Add the file "${f}" to your files` };
        },
        run: async (input, ctx) => {
          const f = ctx.file;
          if (f === undefined) throw new Error("files.add: the file is missing");
          const out = await this.files
            .addFromBytes(ctx.orgId, ctx.actorAccountId, {
              referencedId: input.file.fileId,
              name: f.name,
              ...(input.name !== undefined && { rename: input.name }),
              contentType: f.contentType,
              bytes: f.bytes,
              sha256: f.sha256,
              signal: ctx.signal,
            })
            .catch((e: unknown) => {
              if (e instanceof FileBlobClaimedError) throw new ToolError(BLOB_CLAIMED_TEXT);
              throw e;
            });
          return {
            id: out.id,
            name: out.name,
            size: out.size,
            contentType: out.contentType,
            added: !out.existing,
          };
        },
        handoff: (_input, result) => {
          const id = (result as { id?: unknown } | null)?.id;
          return typeof id === "string"
            ? {
                kind: "handoff",
                title: { zh: "在文件页查看这个文件", en: "View this file on the Files page" },
                target: { type: "link", url: fileLink(id) },
              }
            : null;
        },
      }),
      defineOperation({
        id: "files.delete",
        description:
          "Ask to delete one of your files: nothing is deleted here; this checks the file and hands the person a link to the Files page to confirm the deletion there (its shared links stop working, and conversations show it as no longer available). Takes the id from files.list.",
        input: z.object({ fileId: FileId }).strict(),
        example: { fileId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/files/:id"],
        renames: { fileId: "id" },
        errors: [
          {
            code: "file.not_found",
            next: "Check the id with files.list: only your own files can be read.",
          },
        ],
        // nothing is written: the person deletes on the Files page
        confirm: "read",
        run: async (input, ctx) => {
          const d = await this.library.details(ctx.orgId, ctx.actorAccountId, input.fileId);
          return {
            id: d.file.id,
            name: d.file.name,
            next: "Ask the person to confirm the deletion on the Files page (the link card).",
          };
        },
        handoff: (input) => ({
          kind: "handoff",
          title: {
            zh: "在文件页确认删除这个文件",
            en: "Confirm deleting this file on the Files page",
          },
          target: { type: "link", url: fileLink(input.fileId) },
        }),
      }),
    ]);
  }
}
