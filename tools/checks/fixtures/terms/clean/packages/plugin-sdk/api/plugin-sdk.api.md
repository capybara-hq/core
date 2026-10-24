## API Report File for "@capybara-hq/plugin-sdk"

```ts

// @public
export function defineExtension(manifest: ExtensionManifest): ExtensionManifest;

// @public
export interface ModelInfo {
    capabilities: { vision?: boolean; documents?: boolean };
}

// @public (left for plan 0b)
export type PluginPackageSection = CapybaraPackageSection;

// @public (left for plan 0b)
export function validatePluginPackageJson(pkg: unknown): void;

```
