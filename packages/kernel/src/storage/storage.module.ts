import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { StorageService } from "./storage.service.js";

/**
 * Object storage (`object-store@1` with the kernel's key prefixes): the one {@link StorageService}
 * (the hourly `storage-org-purge` job, `StoragePurgeJob`, is the worker role's: `WorkerModule`).
 */
@Module({
  imports: [ExtensionRegistryModule],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
