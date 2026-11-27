import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { FileDeliveries } from "./deliveries.js";
import { LibraryFilesModule } from "./library.module.js";

/**
 * Delivered and generated files ({@link FileDeliveries}): the blobs of the file library and the
 * conversation log, for the builtin tools that deliver files (`Deliver`, `GenerateImage`).
 */
@Module({
  imports: [LibraryFilesModule, EventLogModule],
  providers: [FileDeliveries],
  exports: [FileDeliveries],
})
export class FileDeliveriesModule {}
