# DataHelm

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="frontend/public/graphics/logos/datahelm-dark.svg" />
  <img src="frontend/public/graphics/logos/datahelm-light.svg" alt="DataHelm." width="300" />
</picture>

A self-hosted MongoDB 8+ administration dashboard. Rust/Axum serves a React, shadcn/ui, and Tailwind frontend. Supports encrypted saved connections, TLS, SSH tunnels, database metadata, users and custom roles, operations, profiling, topology, and seven days of metrics. Atlas administration, document editing, and ClickHouse are outside Phase 1.

## Start with Docker

Requires Docker Compose and an AMD64 Linux Docker host. The default setup pulls the public image from `ghcr.io/amirhmzz/datahelm:latest`; no registry login is required. Setup runs automatically inside the application at runtime; no Bun/Node.js or setup script is needed on the host.

```powershell
Copy-Item .env.example .env
# Edit DATAHELM_ORIGIN in .env to match your reverse proxy's browser URL.
docker compose up -d
docker compose logs datahelm
```

The first startup generates a random encryption key and temporary administrator password. The username (default `admin`) and temporary password appear once in the container logs when the account is created. Sign in with these credentials and set a new password before accessing the dashboard. Later password changes are available from the key icon beside the administrator account in the sidebar. Password changes require the current password and sign out other sessions. New passwords and encryption keys are never logged.

Compose publishes **no host ports**. Connect your reverse proxy to the application's Docker network and route it to `http://datahelm:8080`. Set `DATAHELM_ORIGIN` in `.env` to the exact browser URL, such as `https://datahelm.example.com`; HTTPS origins enable Secure session cookies. For local browser access, explicitly provide your own Compose override with a localhost port mapping.

Set `DATAHELM_IMAGE` in `.env` to select a specific release (for example `ghcr.io/amirhmzz/datahelm:0.1.0`), the development `:edge` tag, a `:sha-<full-commit-sha>` tag, or an immutable `@sha256:...` digest. `latest` follows stable releases; `edge` follows passing builds on `main`. Update the selected image without deleting volumes:

```powershell
docker compose pull
docker compose up -d
```

To build from your local source instead, use the explicit development override:

```powershell
docker compose -f compose.yaml -f compose.build.yaml up --build -d
```

SQLite lives in `datahelm_data`; the generated key lives in the separate `datahelm_secrets` volume at `/var/lib/datahelm/secrets/master_key` (directory mode 0700, key mode 0600). Only the password hash is persisted. Recreating containers reuses the key and account; it does not generate new credentials or print them again. Preserve both volumes.

The application runs as a non-root container user, stores SQLite in a named volume, and places uploaded TLS files only on a private tmpfs. Local development on Windows can use system-root TLS and SSH; uploaded TLS material requires the Linux container's memory-backed directory. MongoDB addresses must be reachable **from the backend**, including advertised replica-set members. In Docker, `localhost` refers to the application container; use `host.docker.internal` for a database on the Docker host.

For an existing deployment created using the former `setup.mjs`, import the **original** `secrets/master_key` into the new secrets volume before starting with this Compose file. The volume name is normally `<compose-project>_datahelm_secrets`. Keep the original key backup; do not generate a replacement for an existing database. Existing administrator credentials are preserved, and the administrator must complete the password-change screen once after this upgrade. External key/password files remain supported through the variables below.

## Configuration

| Variable                       | Default / purpose                                           |
| ------------------------------ | ----------------------------------------------------------- |
| `DATAHELM_IMAGE`               | Compose only: `ghcr.io/amirhmzz/datahelm:latest`             |
| `DATAHELM_BIND`                | `127.0.0.1:8080` outside Docker                             |
| `DATAHELM_ORIGIN`              | `http://localhost:8080`; exact browser origin               |
| `DATAHELM_DATABASE_URL`        | `sqlite://datahelm.db`; Docker uses `/data/datahelm.db`     |
| `DATAHELM_SECRETS_DIR`         | `secrets` outside Docker; `/var/lib/datahelm/secrets` in Docker |
| `DATAHELM_MASTER_KEY_FILE`     | Optional external base64-encoded 32-byte key; overrides automatic key storage |
| `DATAHELM_ADMIN_PASSWORD_FILE` | Optional initial password; otherwise generated automatically |
| `DATAHELM_ADMIN_USERNAME`      | `admin`; used on first boot                                 |
| `DATAHELM_RUNTIME_DIR`         | `/dev/shm/datahelm`; Docker uses `/run/datahelm` on tmpfs   |
| `DATAHELM_FRONTEND_DIR`        | `frontend/dist` relative to working directory               |

The secret variables also accept values without `_FILE` for environments with a secret injector. Explicitly configured unreadable files cause startup failure, without silently generating replacements. Administrator identity and password hash are persisted on first boot; changing bootstrap variables does not reset an existing account. Sessions expire after 12 hours. Login and password-change verification are each limited to five attempts per minute across the single administrator account. An incorrect master key fails startup rather than silently replacing saved records. Keep bootstrap logs private until the temporary password has been changed.

## MongoDB access and behavior

- Use a dedicated MongoDB account. A `root` account enables all features for evaluation; choose narrower resource privileges for production. Monitoring commonly needs `clusterMonitor`, database statistics access, and read access to the relevant `system.profile` collections. User/role management needs the corresponding `viewUser`, `createUser`, `changePassword`, `grantRole`, `revokeRole`, `dropUser`, `viewRole`, `createRole`, and `dropRole` actions. Role updates also require the relevant grant/revoke actions. MongoDB always enforces the final resource-level authorization.
- Connection forms support SCRAM and X.509. `$external` users have roles but no stored MongoDB password. SRV/TXT records must resolve from the backend; SSH forwards database TCP connections and resolves member hostnames from the SSH host, but does not forward SRV DNS queries.
- SSH supports passwords and uploaded private keys with optional passphrases. Fetch and independently verify the SHA256 host fingerprint before trusting it. A changed fingerprint prevents authentication. Private keys take precedence when both a key and password are saved. Clearing or replacing a saved secret must be explicit; omission preserves it.
- Counts and sizes use metadata rather than document scans. Sharded sizes/counts aggregate member responses; logical index counts are not multiplied by shard count. Views display unavailable statistics. Time-series storage statistics count buckets, so DataHelm labels bucket counts separately and leaves measurement counts unavailable rather than reporting buckets as documents.
- Telemetry samples enabled connections every five seconds with bounded concurrency. Slow/unreachable servers may delay samples. History is retained for seven days; longer chart ranges use minute or fifteen-minute buckets. Missing fields, outages, counter resets, and source changes appear as gaps.
- Current operations are scoped to the connected node, including local router operations on `mongos`. Cancellation is manual, requires confirmation, and rechecks a short-lived encrypted operation reference on its original node. Internal and DataHelm operations are excluded from cancellation.
- Profiling is node-specific. To change a replica-set member's profiler, save a single-host connection with direct mode enabled. `mongos` cannot store profiler records; use its recent diagnostic slow log or a direct `mongod` connection. One-click enable uses level 1 and preserves sampling/filter settings. Changing `slowms` also affects that node's diagnostic slow logging. Query contents remain in MongoDB; DataHelm does not persist profile/log payloads.
- Database/collection metadata and built-in roles are read-only. Administrative changes are recorded in `/api/v1/audit` without passwords or query bodies.

## Development and checks

```powershell
bun install --cwd frontend
cargo test
bun scripts/generate-api.mjs
bun run --cwd frontend test
bun run --cwd frontend build
```

Rust requires a native linker/toolchain. For Windows GNU, add your MinGW `bin` directory to PATH; for MSVC use a Visual Studio Developer shell with the C++ build tools. Rust 1.98 and Bun 1.x are used by the container build.

For backend development, run `cargo run` from the repository root. The key is created under `secrets` and initial credentials appear in the terminal; external secret variables are optional. For frontend development run `bun run --cwd frontend dev`; Vite proxies `/api` to port 8080. Set `DATAHELM_ORIGIN=http://localhost:5173` when using that frontend URL. API types are generated from Rust's OpenAPI document into `frontend/src/api-types.ts`; regenerate after interface changes.

Run the complete Docker integration suite with one command:

```powershell
bun scripts/test-integration.mjs --browser
bun scripts/test-integration.mjs --skip-build --browser --topology-version=9
bun scripts/test-startup.mjs
```

This builds the app and runs Rust tests, starts isolated MongoDB 8/9, replica-set, sharded, TLS, and SSH fixtures plus a separate DataHelm instance on port 18080, then applies changes **through DataHelm's HTTP API**. It checks user/role CRUD, effective permissions, catalog statistics, profiling, operation cancellation, SSH key/password authentication, host-key rejection, X.509/TLS, primary failover, tunnel recovery, and persisted monitoring. Frontend component tests run too; `--browser` adds the principal workflows and administrator password changes in installed Chrome (or Edge with `DATAHELM_E2E_BROWSER=msedge`). Omit `--browser` for API-only execution. Use `--skip-build` to reuse a previously built `datahelm:phase1` image. The runner refuses to overwrite existing fixture containers and removes its containers, volumes, and temporary test secrets afterward. Deployment data and runtime remain separate from these fixtures.

The first command uses MongoDB 8 for replica-set, sharding, and TLS fixtures; `--topology-version=9` runs those fixtures on MongoDB 9. Both standalone versions run in every suite. The runner completes the disposable administrator's first-login password change before exercising database administration. `test-startup.mjs` tests the production Compose configuration with fresh disposable volumes and a test-only localhost port override (18081), then recreates the container to verify key/account/connection persistence and one-time credential logging. It removes its own volumes afterward.

Rust integration tests can also run against **disposable** authenticated MongoDB servers:

```powershell
$env:DATAHELM_TEST_URIS = 'mongodb://admin:datahelm-test-only@localhost:28018/?authSource=admin;mongodb://admin:datahelm-test-only@localhost:28019/?authSource=admin'
cargo test mongo_administration_end_to_end -- --ignored --nocapture
```

These tests create uniquely named databases, users, and roles and remove them on successful completion. Never point them at production. Browser tests use `DATAHELM_E2E_URL` and `DATAHELM_E2E_PASSWORD_FILE`, with a locally configured test instance.

Container checks use the same Linux environment as deployment:

```powershell
docker build --target test -t datahelm:test .
docker build -t datahelm:phase1 .
bun scripts/generate-api.mjs --docker
```

For isolated SSH, replica-set, sharding, and TLS fixtures:

```powershell
docker compose -p datahelm-fixtures -f compose.tests.yaml up --build -d
bun scripts/init-fixtures.mjs
```

The fixture services deliberately use test credentials and are separate from deployment. The standalone fixtures expose only localhost ports 28018/28019; SSH uses localhost port 2223. `scripts/validate-fixtures.mjs`, `validate-tls.mjs`, `validate-recovery.mjs`, and `validate-administration.mjs` exercise the corresponding workflows against a local test app; the runner configures their environment automatically. For separate browser checks, set `DATAHELM_E2E_URL`, `DATAHELM_E2E_PASSWORD_FILE`, and `DATAHELM_E2E_MONGO_URI` to your test app and run `bun run --cwd frontend e2e`. Tracing is disabled so test traces do not retain login passwords.

Remove manually started fixtures afterward with `docker compose -p datahelm-fixtures -f compose.tests.yaml --profile integration down -v`. Never reuse these test credentials for deployment.

## CI and Docker releases

GitHub Actions validates pull requests, pushes to `main`, and `v*` tags. It scans the full checked-out Git history for credentials, runs Rust tests and frontend component tests/builds, checks generated API contracts, and validates the runtime image against MongoDB 8/9, browser workflows, and startup/recreation persistence. Release tags must be stable `vX.Y.Z`, match both package versions, and point to a commit on `main`.

Only successful push runs publish images. Pull requests have read-only repository permissions and never receive publishing credentials. A separate publishing job downloads the tested image artifact and pushes it to GHCR with the built-in `GITHUB_TOKEN`; it does not rebuild the image or require a personal access token. The image artifact expires after one day. Workflow actions are pinned to commit SHAs.

| Trigger | Published image tags |
| ------- | -------------------- |
| Push to `main` | `edge`, `sha-<full-commit-sha>` |
| Stable tag such as `v0.1.0` | `0.1.0`, `0.1`, `latest` |

To release, update the version in `backend/Cargo.toml` and `frontend/package.json`, regenerate API contracts if necessary, and merge to `main`. After its CI passes, tag that commit and push the tag:

```powershell
git switch main
git pull --ff-only
git tag v0.1.0
git push origin v0.1.0
```

The repository uses manual version tags. There is no automatic release PR or server deployment. GHCR package visibility is configured separately from repository visibility: after the first publication, set the `datahelm` container package to Public in GitHub package settings and verify an anonymous pull. Published images declare their source repository, commit, version, and MIT license in OCI labels. Production installation requires no Bun or Rust toolchain.

## Backup and restore

Stop DataHelm, back up the SQLite volume and secrets volume separately, then restart. Preserve the entire SQLite database; if copying while the app is stopped, include any remaining `-wal`/`-shm` files. The administrator password is represented only by its hash in SQLite. If you use an externally supplied master key instead of the generated volume key, back up that file separately.

Restore the database volume and the **matching** master key to a new deployment before starting. Losing the key makes connection credentials unrecoverable. Moving only the database is insufficient. Key rotation requires a deliberate decrypt/re-encrypt maintenance procedure; replacing the key file alone is not rotation.

## License

DataHelm is licensed under the [MIT License](LICENSE).
