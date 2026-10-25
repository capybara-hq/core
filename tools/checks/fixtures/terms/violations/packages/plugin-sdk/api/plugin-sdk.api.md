## API Report File for "@capybara-hq/plugin-sdk"

```ts

// @public
export function definePlugin(manifest: ExtensionManifest): ExtensionManifest;

// @public
export interface StaticPluginManifest {
    name: string;
}

// @public
export type CapabilityRef = string;

// @public (an M6 / M7 package format name)
export type PluginPackageSection = CapybaraPackageSection;

// @public (a new name is fine)
export function parsePluginManifest(json: unknown): PluginManifest;
```
