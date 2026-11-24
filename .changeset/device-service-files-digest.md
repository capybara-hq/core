---
"@capybara-hq/device": patch
---

Device services get `CAPYBARA_SERVICE_WORKSPACE` (the device's resolved workspace root). Service
code lives apart from the service's state: the spec's files and their digest are written into a
device-owned `<device dir>/svc-files/<name>` directory the service can only read, and the entry
runs from there. `service.ensure` takes an optional `filesDigest` and may leave out `spec.files`:
a start then reuses the stored files when they were written under the same digest, and otherwise
answers `files_needed` (also when neither files nor a digest are sent).
