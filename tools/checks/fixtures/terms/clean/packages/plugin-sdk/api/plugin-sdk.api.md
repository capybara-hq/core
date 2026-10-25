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

```
