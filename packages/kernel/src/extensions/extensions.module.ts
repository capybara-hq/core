import { Module } from "@nestjs/common";
import { ExtensionRegistry } from "./registry.js";

/**
 * The extensions domain. So far only the shared {@link ExtensionRegistry} (ruling R6): the legacy
 * graph's `ExtensionHost` writes it, other domains read extension points and manifests from it.
 * Task 3.3 moves the host and the rest of `extensions/` here.
 */
@Module({ providers: [ExtensionRegistry], exports: [ExtensionRegistry] })
export class ExtensionsModule {}
