import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { StorageModule } from "../storage/storage.module.js";
import { BlobObjectsModule } from "./blob-objects.js";
import { BlobHashLock, BlobsService } from "./blobs.service.js";
import { LibraryFilesService } from "./library-files.service.js";

/**
 * The file library (file library spec): blobs ({@link BlobsService}) and the person's files
 * ({@link LibraryFilesService}). The hourly cleanup of expired uploads and drafts
 * (`FileDraftCleanupJob`) and the owed object deletions (`BlobObjects`, through the maintenance
 * queue) are the worker role's. Its own module (no conversations dependency) so conversations and
 * tools can use it.
 */
@Module({
  imports: [StorageModule, BlobObjectsModule, EventLogModule],
  providers: [BlobHashLock, BlobsService, LibraryFilesService],
  exports: [BlobsService, LibraryFilesService],
})
export class LibraryFilesModule {}
