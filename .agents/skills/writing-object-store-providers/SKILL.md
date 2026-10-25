---
name: writing-object-store-providers
description: 'Use when creating or changing an object store extension (provides object-store@1, e.g. plugins/object-store-s3), or when using ctx.storage or StorageService in an extension or the kernel: the semantics of each ObjectStore method (range, list pagination, deletePrefix, return null when missing), presigned uploads must have their size limited by the store (POST policy key / content-length-range / Content-Type conditions), rejecting keys containing ${, presignGet disposition and responseContentType; the key prefixes the kernel adds, plugins/<plugin>/<orgId>/ and kernel/<orgId>/, StorageKeyError, TTL limits; the cleanup job after an org is deleted; and writing tests with SeaweedFS (startTestS3).'
---

# Writing object store extensions

Object storage holds attachments, artifacts delivered by sandboxes, skill files and extension data. `object-store@1` is a **single-select, brokered** extension point: a deployment installs only one provider, an extension cannot `requires` it and can only use it through `ctx.storage` (the manifest declares `permissions.storage`). For general extension writing see `.agents/skills/writing-extensions`.

Why this is separate from the sandbox skill: the two have different readers (store extension authors / extension authors who use `ctx.storage`, versus sandbox extension authors), and their contracts and test tooling do not overlap; skills are triggered by description, so writing them separately makes them easier to find.

Reference implementation: `plugins/object-store-s3` (the official `@aws-sdk/client-s3`; it works with the S3-compatible interfaces of AWS S3, MinIO, Ceph, SeaweedFS and OSS / TOS).

## Contract: `ObjectStore` (`packages/plugin-sdk/src/storage.ts`)

| Method | Semantics |
|---|---|
| `put(key, body, { contentType, size?, signal? })` | Overwrites a key of the same name; when `body` is a stream, give `size` if you can; honors `signal` |
| `get(key, { range?, signal? })` | Returns null when missing; `range` is a closed interval, and a missing `end` reads to the end; with a range, `head.size` is still the size of the **whole object** |
| `head(key)` | Returns null when missing; include `etag` where possible (the kernel uses it to check that an attachment was not swapped after finalize) |
| `delete(key)` | A missing key also counts as success |
| `deletePrefix(prefix)` | Deletes every object under the prefix and returns the number deleted; must span multiple pages (S3 allows at most 1000 per batch) |
| `list(prefix, { cursor?, limit? })` | Paginated; a missing `cursor` means there is no next page; when listing carries no type, `contentType` is an empty string |
| `presignGet(key, opts)` | `downloadName` goes into `Content-Disposition` (RFC 6266; non-ASCII uses `filename*=UTF-8''…`); `disposition` defaults to `attachment`; `responseContentType` overrides the response type |
| `presignPut(key, { contentType, maxSize, ttlSeconds })` | Returns `PresignedUpload { method: "PUT" \| "POST", url, headers, fields? }` |

### Presigned upload: the store must reject oversize

- A presigned PUT cannot limit size, so the S3 implementation uses a **POST policy** (Ruling M3). Write the conditions in full and do not rely on SDK defaults: `{ key }` (exact key), `["content-length-range", 0, maxSize]`, `["eq", "$Content-Type", contentType]`. The browser puts the `fields` into the form as they are, and puts the file field `file` **last**.
- **Reject keys containing `${`**: in a POST form, a `${filename}` in the key is replaced by the store with the file name supplied by the uploader, so the exact-key condition turns into "starts with some prefix" and the uploader can write elsewhere. The extension and the kernel (`prefix.ts`) each reject it once.
- `ttlSeconds` must be an integer in 1..604800 (the SigV4 limit of 7 days); the kernel clamps before passing it.
- When switching to another store, first verify that it **really enforces** POST policies (SeaweedFS has been verified to reject oversize, a changed key and a changed type); if it cannot, do not declare support.
- When the browser-reachable address differs from the address the kernel uses, sign with `publicEndpoint` (the host name takes part in the signature and cannot be replaced afterwards). CORS is configured on the bucket by the deployer; see the README.

### How presignGet opens content

User-uploaded content uses `inline` only for types that do not execute scripts (images, PDF), and the kernel never gives inline for other types (Ruling M9); `responseContentType` makes the response come back with the type the kernel verified, rather than the type recorded in the store.

## The layer the kernel adds: `StorageService` (`packages/kernel/src/storage`)

The provider only sees full keys; the prefixing and isolation are done by the kernel (extension model §5):

- The `ctx.storage` (`ExtensionStorage`) an extension gets has a leading `orgId` on every method, and keys land under **`plugins/<plugin name>/<orgId>/`**; kernel features use **`kernel/<orgId>/`** (attachments `attachments/…`, artifacts `artifacts/<conversation>/<id>`, skills `skills/<upload id>/…`). Deployment-level kernel data is under **`deployment/`** (for example extension packages at `deployment/plugins/blobs/<sha256>.tgz`, recorded in PG as `extension_packages.blob_store = 'object'`). Keys returned to the caller have the prefix stripped, and listing keeps only objects under this prefix.
- **Changing the bucket / address**: PG only records "in the object store", not which bucket. After a deployment changes the bucket or endpoint of the object store extension, the old bucket's objects (attachments, artifacts, skills, extension packages) cannot be found in the new bucket: extension package sync fails (replica status `sync_failed`, with the details naming the missing key), and attachments and the like are treated as "no longer available". Before switching, copy the old bucket's `deployment/`, `kernel/` and `plugins/` prefixes over as a whole; an extension package can also be restored by uploading the same tgz again.
- Validation happens before the provider is called: `orgId` must be a UUID (normalized to lower case); a relative key must not be empty, must not start with `/`, and must not have `.` / `..` segments, `\`, control characters or `${`; after the prefix is added it must be <= 1024 bytes; otherwise `StorageKeyError` is thrown.
- With no provider, each method rejects with `storage.unavailable` (HTTP 503); an extension that declares `permissions.storage` does not load (pending, reason dependency).
- **Cleanup after an org is deleted**: the maintenance job `storage-org-purge` claims, every hour, a batch of orgs that were deleted more than `storage.purgeDeletedOrgsAfterDays` (default 30) days ago, runs `deletePrefix` on `kernel/<orgId>/` and on each extension's `plugins/<plugin>/<orgId>/`, and records `storage_purged_at` on success. So `deletePrefix` must be re-entrant and retryable; orphan objects (failed uploads, rejected skill drafts) are eventually cleared by it.
- When the store errors temporarily, building a model request does not downgrade media to a placeholder; it makes that step retry as a retryable error (Ruling M4), because otherwise the request is not reproducible. A provider should throw transient failures as they are, not swallow them and not return null (null means certainly does not exist).

## Writing notes

- Stateless: build the client from config, and do not cache connections or credentials at module level (multi-replica discipline). Use `secret()` for key fields.
- Stream uploads / downloads; do not read a large object entirely into memory.
- Error messages carry no credentials or signatures.
- The CLI (`capybara plugins import`, `capybara bootstrap` for a declarative entry) stores plugin files through your store without a plugin host (`loadCliObjectStore` in `packages/kernel/src/catalog/cli.ts`): it runs your `setup` with a context offering only `ctx.config` and `ctx.provide` (any other `ctx` member throws). It uses a config-declared store first (approved and configured), else an install record (a bootstrap install such as `object-store-s3`, or one installed from the admin console) that is desired enabled, provides `object-store@1`, is not shadowed by a config-declared name, is approved (its snapshot covers the package, or `extensionPermissions.autoApprove`) and configured (the deployment config stored in PG merged with the startup config, validated by your schema); its package is synced into a temporary directory removed afterwards. An install record whose package has migrations that have not run yet for that package is skipped ("awaits its migrations"): start a kernel once first. Keep `setup` to building the store from `ctx.config` and calling `ctx.provide`, or the CLI refuses with "Object storage is not available to the CLI" and the plugin must be imported in the admin console.

## Testing

- `startTestS3()` from `@capybara-hq/testing`: the official SeaweedFS image (`TEST_S3_IMAGE`, which can be swapped for a private source with `CAPYBARA_TEST_S3_IMAGE`); it returns `{ endpoint, region, bucket, accessKey, secretKey }`, accessed path-style. The dev compose file `docker/compose.dev.yaml` uses the same image.
- A provider should cover at least: put / head / get (including range) / delete, streaming put (with and without size), abort, list pagination, deletePrefix across multiple batches, presignGet disposition and file name, presignPut with over `maxSize` / a changed key / a changed type rejected by the **store**, `${` keys rejected, the TTL range, and `publicEndpoint`. See `plugins/object-store-s3/test/s3.test.ts`.
- Kernel tests and tests of extensions that use `ctx.storage` load `object-store-s3` + `startTestS3()` directly; for examples see `packages/kernel/test/skills/*`.
