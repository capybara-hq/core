# Guide

Plugin schemas stay `plugin_<name>`.
Set `CAPYBARA_PLUGIN_CONFIG__OBJECT_STORE_S3__BUCKET` to choose the bucket.
Review requests at /admin/directory/requests.
Org admins open /settings/apps.
Tests call `assertPluginSecretsReachable(manifest)`.
Bundles are described in `writing-apps`.
Bundles list their plugins in `app.yaml`.
The package.json section sets `capybara.kind` to "plugin".
Call `parseAppManifest(text)` on the bundle.
Each entry has one of `PACKAGE_KINDS`.
Read the old index with `parseCatalogIndex(json)`.
It returns a `CatalogIndex`.
Tests build a bundle with `appBundleTgz()`.
