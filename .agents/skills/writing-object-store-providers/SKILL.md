---
name: writing-object-store-providers
description: 'Use when changing the kernel side of object-store@1 or using ctx.storage / StorageService in the kernel: the ObjectStore contract as the kernel relies on it (range, list pagination, deletePrefix, null when missing, presigned uploads whose size the store must enforce, rejecting keys containing ${, presignGet disposition and responseContentType), the key prefixes the kernel adds (plugins/<plugin>/<orgId>/, kernel/<orgId>/, deployment/), StorageKeyError, TTL clamping, storage.unavailable, the storage-org-purge cleanup job, the CLI object store (loadCliObjectStore), and kernel tests with the fake-object-store extension and SeaweedFS (startTestS3). To write an object store extension (object-store-s3) see writing-object-store-providers in capybara-hq/plugins.'
---

# Object storage: the kernel side of `object-store@1`

Object storage holds attachments, artifacts delivered by sandboxes, skill files, plugin packages and extension data. `object-store@1` is a **single-select, brokered** extension point: a deployment installs only one provider, an extension cannot `requires` it and can only use it through `ctx.storage` (the manifest declares `permissions.storage`). For the extension host see `.agents/skills/writing-extensions`.

This skill covers what core owns: the contract as the kernel relies on it, `StorageService` (prefixes, validation, cleanup), the CLI object store and the kernel tests. **Writing an object store extension** (client setup, POST-policy details, `publicEndpoint`, its tests) is in [writing-object-store-providers in capybara-hq/plugins](https://github.com/capybara-hq/plugins/tree/main/.agents/skills/writing-object-store-providers); the official implementation is [`object-store-s3`](https://github.com/capybara-hq/plugins/tree/main/plugins/object-store-s3), a bootstrap plugin (`packages/kernel/bootstrap.json` pins its npm version and sha512, so every deployment installs it).

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
- A store that cannot **really enforce** these conditions must not offer presigned uploads; the kernel trusts the store to reject oversize, a changed key and a changed type.

### How presignGet opens content

User-uploaded content uses `inline` only for types that do not execute scripts (images, PDF), and the kernel never gives inline for other types (Ruling M9); `responseContentType` makes the response come back with the type the kernel verified, rather than the type recorded in the store.

## The layer the kernel adds: `StorageService` (`packages/kernel/src/storage`)

The provider only sees full keys; the prefixing and isolation are done by the kernel (extension model §5):

- The `ctx.storage` (`ExtensionStorage`) an extension gets has a leading `orgId` on every method, and keys land under **`plugins/<plugin name>/<orgId>/`**; kernel features use **`kernel/<orgId>/`** (attachments `attachments/…`, artifacts `artifacts/<conversation>/<id>`, skills `skills/<upload id>/…`). Deployment-level kernel data is under **`deployment/`** (for example extension packages at `deployment/plugins/blobs/<sha256>.tgz`, recorded in PG as `extension_packages.blob_store = 'object'`). Keys returned to the caller have the prefix stripped, and listing keeps only objects under this prefix.
- **Changing the bucket / address**: PG only records "in the object store", not which bucket. After a deployment changes the bucket or endpoint of the object store extension, the old bucket's objects (attachments, artifacts, skills, extension packages) cannot be found in the new bucket: extension package sync fails (replica status `sync_failed`, with the details naming the missing key), and attachments and the like are treated as "no longer available". Before switching, copy the old bucket's `deployment/`, `kernel/` and `plugins/` prefixes over as a whole; an extension package can also be restored by uploading the same tgz again.
- Validation happens before the provider is called: `orgId` must be a UUID (normalized to lower case); a relative key must not be empty, must not start with `/`, and must not have `.` / `..` segments, `\`, control characters or `${`; after the prefix is added it must be <= 1024 bytes; otherwise `StorageKeyError` is thrown.
- With no provider, each method rejects with `storage.unavailable` (HTTP 503); an extension that declares `permissions.storage` does not load (pending, reason dependency).
- **Cleanup after an org is deleted**: the hourly job `storage-org-purge` (`@LockedCron` in `storage/purge.ts`, once per tick across replicas) claims a batch of orgs that were deleted more than `storage.purgeDeletedOrgsAfterDays` (default 30) days ago, runs `deletePrefix` on `kernel/<orgId>/` and on each extension's `plugins/<plugin>/<orgId>/`, and records `storage_purged_at` on success. So `deletePrefix` must be re-entrant and retryable; orphan objects (failed uploads, rejected skill drafts) are eventually cleared by it.
- When the store errors temporarily, building a model request does not downgrade media to a placeholder; it makes that step retry as a retryable error (Ruling M4), because otherwise the request is not reproducible. A provider should throw transient failures as they are, not swallow them and not return null (null means certainly does not exist).

## The CLI object store

The CLI (`capybara plugins import`, `capybara bootstrap` for a declarative entry) stores plugin files through the deployment's store without a plugin host (`loadCliObjectStore` in `packages/kernel/src/catalog/cli.ts`): it runs the provider's `setup` with a context offering only `ctx.config` and `ctx.provide` (any other `ctx` member throws). It uses a config-declared store first (approved and configured), else an install record (a bootstrap install such as `object-store-s3`, or one installed from the admin console) that is desired enabled, provides `object-store@1`, is not shadowed by a config-declared name, is approved (its snapshot covers the package, or `extensionPermissions.autoApprove`) and configured (the deployment config stored in PG merged with the startup config, validated by the extension's schema); its package is synced into a temporary directory removed afterwards. An install record whose package has migrations that have not run yet for that package is skipped ("awaits its migrations"): start a kernel once first. A provider whose `setup` does more than build the store from `ctx.config` and call `ctx.provide` makes the CLI refuse with "Object storage is not available to the CLI"; the plugin must then be imported in the admin console.

## Testing

- `startTestS3()` from `@capybara-hq/testing`: the official SeaweedFS image (`TEST_S3_IMAGE`, which can be swapped for a private source with `CAPYBARA_TEST_S3_IMAGE`); it returns `{ endpoint, region, bucket, accessKey, secretKey }`, accessed path-style. The dev compose file `docker/compose.dev.yaml` uses the same image.
- Kernel tests that need a store load the **`fake-object-store`** extension of `@capybara-hq/testing` (`fakeExtensionEntry("fake-object-store")`, `object-store@1` on the `startTestS3()` container with POST-policy presign, deployment config as `TestS3` gives it); `fake-storage-user` covers an extension using `ctx.storage`, and `fake-bootstrap-b` a store kept in its own PG table (bootstrap tests). For examples see `packages/kernel/test/skills/*` and `packages/kernel/test/evals/reconstruct.test.ts`. Core tests never load `object-store-s3`; its own tests live in capybara-hq/plugins.
