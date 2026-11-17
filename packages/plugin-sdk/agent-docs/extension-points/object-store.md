# Authoring: extension point object-store

<!-- generated:extension-point -->
- Name: `object-store` (a ref is `object-store@<major>`)
- Stores files and artifacts in S3-compatible object storage, with presigned uploads.
- Providers: one at a time
- Enabled per org: no
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: ObjectStore (`storage.ts`)

Return `null` for a missing key, reject keys containing `${`, and enforce the size of presigned uploads in the store itself. The kernel adds key prefixes; extensions consume it as `ctx.storage`.

Optionally implement `uri(key)`: the store's canonical identifier for a key, such as `s3://bucket/key`. It is unsigned, stable and carries no credentials, and is never a presigned URL — the kernel may record it in an event log and show it to a model. A store with no notion of URIs simply leaves it out.

See `extensions` for the rules every extension follows.
