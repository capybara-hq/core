import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { FileIdParams, LibraryListQuery } from "../../files/library.schemas.js";
import { type LibraryFileView, LibraryQuery } from "../../files/library-query.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";

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
  versions: f.versions,
  createdAt: f.createdAt,
});

/**
 * File library operations of the `Platform` tool (file library spec §6, §8): the person's own
 * files, as the Files page shows them. Bytes, previews and the HTML document stay with the web
 * (`transport` exclusions); deleting a file is confirmed by the person on the Files page, so
 * `files.delete` only checks the file and hands them the link.
 */
@Injectable()
export class FilesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(LibraryQuery) private readonly library: LibraryQuery,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "files.list",
        description:
          "List your files (the Files page), newest first: files you uploaded and files agents delivered or generated in your conversations, each with id, name, type, size, origin, the agent and the conversation it came from (deleted conversations keep their files) and the number of versions (repeated deliveries of one path in one conversation are one entry). Filter by origin, agentId, type (image, document, text, other) or q (part of the name). Pages by 50: pass the returned next as params.cursor.",
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
          target: { type: "link", url: `/files#item=${encodeURIComponent(input.fileId)}` },
        }),
      }),
    ]);
  }
}
