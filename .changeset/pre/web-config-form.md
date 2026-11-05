---
"@capybara-hq/web": patch
---

One config form renderer for every extension config: deployment config, org extension settings,
channel connections, the catalog install wizard and the plugin upgrade dialog. It draws the JSON
Schema with its `x-ui` hints (labels, help, units, options, sections, the Advanced disclosure),
arrays of objects as repeaters (endpoints with their models as compact rows, presets), records as
key / value rows, secrets as keep / replace / clear (a key per endpoint for records drawn per item,
saved through `secretEntries`, renames keep the key), unions as JSON. Server issues land on their
field by `segments` (`messageKey` picks the localized hint message); a pending-config extension
opens on its form with the missing fields listed. Replaces `SchemaForm`, the flat deployment form
and the JSON stopgap for object-valued secrets.

Design: `KeyValueEditor` takes `maskValues` (password value inputs, used for secret records), and
after an add a `Repeater` focuses the new item's first empty required field.
