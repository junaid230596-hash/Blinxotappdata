# File storage (local disk or cloud)

Blinxot stores uploaded files in one of two places, chosen with `STORAGE_DRIVER`:

| Driver | Where files live | Use it when |
|---|---|---|
| `local` (default) | The server's disk (`UPLOAD_DIR`, plus `<UPLOAD_DIR>-private`) | One server, small volume, simplest setup |
| `s3` | An S3-compatible bucket: **AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO, Wasabi...** | You want files off the server (survives a server rebuild, no disk to fill, easier scaling) |

## How files are accessed
- **Public images** (logos, product images, profile photos) are saved with a random name and shown at `/uploads/<name>`. The API reads them from the bucket and serves them with long-lived cache headers.
- **Private files** (employee documents) are only ever downloaded through the app, after the permission check (`documents.view`, or the employee's own copy when HR shared it). They are never reachable at `/uploads/`.
- **The bucket stays private.** Nothing links to it directly, so there is no "public bucket" to misconfigure, and the app's rules and security headers apply to every download. (Do **not** make the bucket public.)
- Database records and URLs are the same with either driver, so you can switch later without editing data.

## Set it up
1. Create a bucket (private, default settings) and an access key limited to that bucket with **read, write and delete** permission.
2. Put the values in `server/.env` (or `/etc/blinxot/server.env`):

| Provider | `S3_ENDPOINT` | `S3_REGION` | Notes |
|---|---|---|---|
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | Create an R2 API token with *Object Read & Write* for the bucket. No egress fees. |
| AWS S3 | leave empty | the bucket's region, e.g. `ap-south-1` | Use an IAM user with a policy limited to `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on this bucket only. |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | the region in the endpoint, e.g. `us-west-004` | Application key with access to the bucket. |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` | the Space's region, e.g. `blr1` | Spaces access key. |

```
STORAGE_DRIVER=s3
S3_BUCKET=blinxot-files
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=production          # optional folder; lets staging and production share one bucket
```
3. Check it: `cd server && npm run storage:test`. It writes, reads and deletes a small test file and explains any problem (wrong key, wrong bucket, wrong region or endpoint, no permission, unreachable). The API runs the same check at startup and logs `file storage verified` or the reason it is not working.
4. Restart the API. New uploads go to the bucket.

Keys live only in the environment file: never commit them. If a key is ever exposed, delete it in the provider's dashboard and create a new one.

## Move existing files into the bucket
Already have uploads on the server? After step 3:
```bash
cd server
npm run storage:migrate                    # copies local files to the bucket; safe to repeat, skips files already there
# check the site: images and employee documents still open
npm run storage:migrate -- --delete-local  # optional: removes each local copy only after the bucket is confirmed to hold it
```
Until you migrate, files that are still on disk keep working (the app falls back to the local copy).

## Backups
With `s3`, `deploy/backup.sh` backs up only the database. Protect the files in the bucket itself: turn on **bucket versioning** (or the provider's backup/replication feature), or copy the bucket periodically to a second bucket or provider (`rclone sync`). Keep the bucket in the same account that the database backups' owner controls, and test a restore.

## Speed and cost
Each image view is served by the API from the bucket and is cached by browsers for a year. For a busy site put nginx's cache (or a CDN such as Cloudflare in front of your domain) in front of `/uploads/`; file names never change, so caching is safe. Storage use still counts against each plan's storage limit.

## Troubleshooting
| Message | Meaning |
|---|---|
| `InvalidAccessKeyId` / `SignatureDoesNotMatch` | Wrong key ID / secret (check for spaces), or the endpoint belongs to a different account. |
| `NoSuchBucket` | Bucket name typo (case-sensitive) or not created yet. |
| `AccessDenied` | The key is valid but lacks permission on this bucket. |
| `PermanentRedirect` / wrong region | `S3_REGION` (AWS) or `S3_ENDPOINT` (others) does not match the bucket. |
| `ENOTFOUND` / `ETIMEDOUT` | Endpoint typo, no internet, or a firewall. |
| Upload returns 502 "File storage is temporarily unavailable" | The bucket could not be reached at that moment. Nothing was saved; the user can retry. See the API log for the exact cause. |
| Certificate errors | Antivirus/proxy interception or a private service; see the SMTP certificate notes in `docs/ENVIRONMENT.md` (`NODE_EXTRA_CA_CERTS`). |
