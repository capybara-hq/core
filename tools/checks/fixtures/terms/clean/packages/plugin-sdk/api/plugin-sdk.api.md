## API Report File for "@capybara-hq/plugin-sdk"

```ts

// @public
export function defineExtension(manifest: ExtensionManifest): ExtensionManifest;

// @public
export interface ModelInfo {
    capabilities: { vision?: boolean; documents?: boolean };
}

// @public (Plugin now means the bundle)
export interface PluginManifest {
    extension?: PluginExtensionSection;
}

// @public
export function parsePluginManifest(json: unknown): PluginManifest | { errors: string[] };

// @public (left for plan 0b Task 9)
export type PluginPackageSection = CapybaraPackageSection;

// @public (left for plan 0b Task 9)
export function validatePluginPackageJson(pkg: unknown): void;

```
