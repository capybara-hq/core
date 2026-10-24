# Guide

Set `CAPYBARA_EXTENSION_CONFIG__OBJECT_STORE_S3__BUCKET`, run `capybara extensions review` and
read `writing-extensions`. Plugin schemas stay `plugin_<name>`; `directory@1` and
`directory_exclusions` are unchanged; the model's `capabilities.vision` is unchanged.
Frozen names stay: the `/plugin-ui` proxy, the web route `/p/[plugin]/x`, the model-visible
`PLUGIN_UNLOADED_TOOL_ERROR`, the `skills_catalog` event, and the extension route prefix
`/plugins/todo/x`. Pages `/admin/extensions`, `/admin/catalog`, `/settings/extensions` and
`/settings/plugins` are new names.
