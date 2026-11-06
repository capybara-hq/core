# Object storage (attachments, artifacts, skill files)

Object storage is provided by an `object-store@1` extension, with the default implementation `@capybara-hq/plugin-object-store-s3` (the official `@aws-sdk/client-s3`): it works with AWS S3, MinIO, Ceph, SeaweedFS, and with Alibaba Cloud OSS and Volcano Engine TOS, which offer S3-compatible APIs. One deployment has one bucket; extensions read and write through `ctx.storage`, with keys automatically prefixed `plugins/<plugin>/<org id>/` (the kernel itself uses `kernel/<org id>/`), so they can't see each other. Large files are uploaded directly from the browser through presigned URLs and downloaded directly, without going through the kernel; the upload size is limited by the storage side through policy.

The local `docker/compose.dev.yaml` ships the official SeaweedFS image (`chrislusf/seaweedfs`, pinned by tag plus digest): the S3 API is at `localhost:8333`, the credentials are `capybara` / `capybara-secret`, and the filer's file browser is at <http://localhost:8888>. The one-shot container `createbuckets` creates the bucket `capybara`. Tests use the same image (`startTestS3()`), and `CAPYBARA_TEST_S3_IMAGE` can switch it to a private image source. To enable it:

`object-store-s3` is a bootstrap plugin and doesn't need to be listed in `CAPYBARA_EXTENSIONS` (a starting kernel installs it, see [Development](../development.md)); you only give the deployment-level config (the enterprise admin can also fill it in in the admin console):

```bash
export CAPYBARA_EXTENSION_CONFIG='{"object-store-s3":{"endpoint":"http://localhost:8333","region":"us-east-1","bucket":"capybara","accessKeyId":"capybara","secretAccessKey":"capybara-secret","forcePathStyle":true}}'
# or field by field: CAPYBARA_EXTENSION_CONFIG__OBJECT_STORE_S3__SECRET_ACCESS_KEY=...
```

| Field | Description |
|---|---|
| `endpoint` | The address of the S3-compatible service; leave it out for AWS S3 (the endpoint comes from `region`) |
| `region` | The region; use `us-east-1` for SeaweedFS and MinIO |
| `bucket` | The bucket name (must be created beforehand) |
| `accessKeyId` / `secretAccessKey` | Credentials (secret fields, stored encrypted, masked in logs) |
| `forcePathStyle` | Path-style access (`<endpoint>/<bucket>/<key>`); SeaweedFS, MinIO and Ceph generally need it on; default `false` |
| `publicEndpoint` | An address reachable from the browser, which presigned URLs are signed against; fill it in when the kernel uses the internal `endpoint` and browsers use a public domain |

For direct browser uploads and downloads, the bucket must allow cross-origin requests from the web origin (CORS: `GET`, `POST`, `PUT`, and request headers such as `Content-Type`). Set `AllowedOrigins` to the web app's origin (scheme + domain + port).

AWS S3 (paste into the console under "Permissions → Cross-origin resource sharing (CORS)"):

```json
[
  {
    "AllowedOrigins": ["https://capybara.example.com"],
    "AllowedMethods": ["GET", "POST", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

For MinIO, Ceph and other S3-compatible storage that supports `PutBucketCors`, use the AWS CLI pointed at your own endpoint (`aws s3api put-bucket-cors --endpoint-url http://minio:9000 --bucket capybara --cors-configuration file://cors.json`):

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://capybara.example.com"],
      "AllowedMethods": ["GET", "POST", "PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Older MinIO versions that don't support per-bucket CORS use the environment variable `MINIO_API_CORS_ALLOW_ORIGIN` to set the allowed origins. SeaweedFS allows cross-origin requests by default, so the development compose file and tests need no extra setup.

When the object-store extension isn't configured properly (the admin console shows "pending configuration"): extensions that declare `permissions.storage` aren't loaded (`capybara extensions review` and the startup log say `object-store@1` is missing), and kernel features that depend on storage return `storage.unavailable` (503). After an org is deleted, its objects are purged for good by a maintenance task after `storage.purgeDeletedOrgsAfterDays` (default 30) days. While the org still exists, skill objects aren't cleaned up on deletion: soft-deleted skills, old skill versions, and agent-level skills of deleted agents all keep their files in object storage until this cleanup after the org is deleted (the skill catalog snapshots in the log and loaded versions still reference them).

**Attachments and image / PDF input**: once object storage is installed, the conversation input box can take attachments (by default each ≤ 20MB and ≤ 10 per message, with types limited to PNG / JPEG / GIF / WebP, PDF, and plain text / Markdown / CSV, see `attachments.*` in `docs/config.md`). When a model declares support for images (`vision`) or documents (`documents`), it receives the original file; when it doesn't, it receives only an English text placeholder, and the bytes are never sent to a model that doesn't support them. The event log records only attachment references. The total media per request is limited by `attachments.requestMediaBytes`, and when it is exceeded, earlier attachments are replaced by placeholders. To write storage extensions, see [.agents/skills/writing-object-store-providers](../../.agents/skills/writing-object-store-providers/SKILL.md).
