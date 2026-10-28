import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { StoragePurgeJob } from "./purge.js";
import { StorageService } from "./storage.service.js";

/**
 * Object storage (`object-store@1` with the kernel's key prefixes): the one {@link StorageService}
 * and the hourly `storage-org-purge` job.
 */
@Module({
  imports: [ExtensionRegistryModule],
  providers: [StorageService, StoragePurgeJob],
  exports: [StorageService],
})
export class StorageModule {}
