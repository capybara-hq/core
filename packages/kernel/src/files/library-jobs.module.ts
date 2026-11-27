import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module.js";
import { FileLibraryHashJob } from "./hash-job.js";
import { LibraryFilesModule } from "./library.module.js";
import { FileLibraryBackfill } from "./library-backfill.js";

/**
 * The file library's background jobs that the maintenance queue runs: the one-off catch-up copy
 * ({@link FileLibraryBackfill}) and the hashing of migrated blobs ({@link FileLibraryHashJob}).
 * Imported by the worker role only (`MaintenanceModule`, `WorkerModule`), which also provides
 * their kickoff and the daily blob sweep.
 */
@Module({
  imports: [StorageModule, LibraryFilesModule],
  providers: [FileLibraryBackfill, FileLibraryHashJob],
  exports: [FileLibraryBackfill, FileLibraryHashJob],
})
export class FileLibraryJobsModule {}
