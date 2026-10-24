# FluxCD Notifications OpenTelemetry Adapter - Agent Instructions

## Project Overview

A lightweight TypeScript server that receives FluxCD notification webhooks and forwards them as OpenTelemetry logs to a configured collector. It enables observability pipelines to capture GitOps reconciliation events (deployments, image updates, alerts) alongside application telemetry.

## Project Structure

```
fluxcd-notifications-otel-adapter/
  src/
    App.ts                # Entry point: Fastify server, OTel init, signal handling, shutdown
    AppRoutes.ts          # Route registration: status endpoint, Flux webhook forwarding, rejections
    Config.ts             # Extends ConfigBase from @devopsplaybook.io/common-utils
    RateLimiter.ts        # In-process per-client-IP fixed-window rate limiter
    OTelContext.ts        # Calls createOTelContext() once and re-exports its accessors
    App.spec.ts           # Route integration tests (Fastify inject on registerRoutes)
    AppLifecycle.spec.ts  # Startup/shutdown and signal handling tests
    AppMetrics.spec.ts    # Metric emission tests
    Config.spec.ts        # Config construction and reload delegation tests
    OTelContext.spec.ts   # OTelContext wiring tests
    RateLimiter.spec.ts   # Rate limiter tests
  config.json             # Default runtime configuration (empty object)
  Dockerfile              # Multi-stage build (node:26-alpine)
  docs/                   # Deployment examples (Kubernetes/Kustomize, Docker Compose)
```

## Coding Conventions

- **Language**: TypeScript (strict mode off, ES6 target, CommonJS modules)
- **Runtime**: Node.js 26
- **Build**: `tsc` compiles `src/` to `dist/` (with `skipLibCheck: true`), then type-checks the spec files (`tsc -p tsconfig.spec.json --noEmit`)
- **Dev mode**: `tsx watch ./src/App.ts`
- **Tests**: Jest with `@swc/jest` (v8 coverage provider), spec files named `*.spec.ts` alongside source, run with `npm test`
- **Linting**: oxlint (recommended preset)
- **Config loading**: `Config` extends `ConfigBase` from `@devopsplaybook.io/common-utils`; env vars override config.json which overrides defaults. The configuration is loaded **once** at startup and there is **no reload or file watcher**: every change requires a process/rollout restart.
- **Secrets in logs**: Sensitive config values (authorization headers, keys) are masked as `********************` by `ConfigBase.reload()`

## Architecture

### Shared Libraries

This project consumes two shared libraries from `devopsplaybook.io/_libs/`:

- **`@devopsplaybook.io/common-utils`** — provides `ConfigBase` (config loading with env/file/default layering, type coercion, sensitive field masking) and `createOTelContext` (tracer/meter/logger singleton factory)
- **`@devopsplaybook.io/otel-utils-fastify`** — provides `StandardTracerFastifyRegisterHooks` for automatic request tracing via Fastify hooks

Importing the `common-utils` barrel loads its full database and authentication stack (better-sqlite3, pg, bcrypt, jsonwebtoken, axios; ~563 modules, ~0.4 s) even though this adapter uses none of it. That is why the Docker builder needs native build tooling.

### OTelContext Pattern

`src/OTelContext.ts` calls `createOTelContext()` once at module load and re-exports the returned functions (`OTelTracer`, `OTelSetTracer`, `OTelMeter`, `OTelSetMeter`, `OTelLogger`). All other modules import from `./OTelContext` rather than creating their own context. `OTelRequestSpan` and `OTelRequestContext` are **not** re-exported: they come from `@devopsplaybook.io/otel-utils-fastify`.

### Config Pattern

`src/Config.ts` extends `ConfigBase` with `serviceId = "fluxcd-notifications"`. Project-specific fields are registered with `addConfigField` in the constructor:

- `WEBHOOK_AUTHORIZATION_HEADER` — optional shared-secret check on `POST /` (sensitive, masked in logs)
- `WEBHOOK_RATE_LIMIT_PER_MINUTE` — per-client-IP limit, default `600`, `0` disables the limiter

The constructor also overrides `VERSION` with the application's `package.json` version (`ConfigBase` otherwise reports the shared library's version, which breaks release identification in telemetry). The `reload()` method delegates to `super.reload()` with a logger callback; it is only called during startup.

### Request Flow

1. FluxCD sends a POST to `/` with the Kubernetes Event object (severity, message, reason, involvedObject, metadata, reportingController, timestamp)
2. Rate limiting runs first, before body parsing and before authentication: `WEBHOOK_RATE_LIMIT_PER_MINUTE` per client IP in a fixed 60 s window (at most 10 000 tracked clients); over the limit → `429` + `Retry-After`, counted as `rate_limited`
3. When `WEBHOOK_AUTHORIZATION_HEADER` is set, the request must carry the exact same `Authorization` header (timing-safe, `401` + `WWW-Authenticate: Bearer` otherwise)
4. Fastify rejects oversized bodies (`413`, 64 KiB limit) and unsupported content types (`415`) before the handler runs
5. The handler requires only a non-empty `message`: a missing/blank message is `400 invalid_payload`. `reason` and `metadata.cluster` default to `unknown`
6. Accepted events are emitted as one OTel log record via `StandardLogger.getLogger().emit()` when a logs endpoint is configured: severity mapped from the Flux severity (info→INFO, error→ERROR, warn/warning→WARN, else INFO), body `<cluster>: <reason> - <message>`, and `flux.*` attributes (cluster, reason, severity, object kind/name/namespace/apiVersion/uid, revision, reporting_controller, `flux.message.truncated` when applicable) with the request OTel context attached. A console line `[level] [fluxcd-notifications] <body>` is always printed; with no logs endpoint the event goes to the console only through the module logger
7. Events are counted in `events_total{cluster, reason, severity}`; counters are only exported when a metrics endpoint is configured
8. The response is `{"status":"ok"}`; a health check is available at `GET /api/status` → `{ started: true, version: "<version>" }`

Rejection reasons counted exactly once in `rejected_events_total{reason}`: `invalid_payload` (400), `invalid_json` (400), `unauthorized` (401), `bad_request` (404 and other 4xx), `payload_too_large` (413), `unsupported_media_type` (415), `rate_limited` (429). Each rejection logs a WARN with route/status/reason; `invalid_payload` adds a sanitized ≤200-character excerpt, `invalid_json` deliberately logs no body. 5xx responses are logged at ERROR and are **not** counted as rejections.

### Severity

`flux.severity` on the log record keeps the trimmed, lower-cased raw value (`unknown` when absent, arbitrary values such as `critical` preserved). Only the metric `severity` label is normalized to `info|warn|error|unknown`. Log severity: info→INFO, error→ERROR, warn/warning→WARN, anything else→INFO.

### Fastify Hooks and Limits

`StandardTracerFastifyRegisterHooks` is registered with `rootApiPath: "/"` so webhook requests to `POST /` are traced (the default `/api` root silently skips them), and `ignoreList: ["GET-/api/status"]` to avoid tracing health checks.

Fixed Fastify limits (`src/App.ts`): body 64 KiB, connection timeout 10 s, request timeout 15 s, keep-alive timeout 72 s. Shutdown flushes telemetry with a 10 s bound.

### Graceful Shutdown

On `SIGTERM`/`SIGINT` the server stops accepting requests, closes Fastify, flushes logs/traces/metrics with a 10 s bound and exits 0; a second signal exits immediately with code 1.

## Configuration

All config is loaded once by `Config.reload()` in this priority order:

1. Environment variables (highest priority)
2. `config.json` file
3. `ConfigBase` class defaults

There is no live reload: changing the file or the environment requires a restart. The Kubernetes manifests mount `config.json` with `subPath`, which is not updated in place either.

Key inherited configuration values from `ConfigBase`:

- `SERVICE_ID` — OpenTelemetry service name (default: `fluxcd-notifications`)
- `API_PORT` — HTTP listen port (default: `8080`)
- `CONFIG_FILE` — configuration file path, environment variable only (default: `config.json`)
- `OPENTELEMETRY_COLLECTOR_HTTP_TRACES` — OTel collector traces endpoint (empty = disabled)
- `OPENTELEMETRY_COLLECTOR_HTTP_METRICS` — OTel collector metrics endpoint (empty = disabled)
- `OPENTELEMETRY_COLLECTOR_HTTP_LOGS` — OTel collector logs endpoint (empty = console only)
- `OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS` — log export interval (default: `60`, and the batch flush delay)
- `OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS` — metrics export interval (default: `60`)
- `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER` — token sent to the collector as `Authorization: Bearer <value>` (sensitive, masked in logs)

Project-specific configuration values:

- `WEBHOOK_AUTHORIZATION_HEADER` — when set, `POST /` requires the exact same `Authorization` header (401 otherwise); empty by default (no auth, startup warning)
- `WEBHOOK_RATE_LIMIT_PER_MINUTE` — per-client-IP limit over a fixed 60 s window; default `600`, `0` disables

## Docker

- Multi-stage build: `node:26-alpine` builder installs `python3 perl alpine-sdk` to compile native modules, then builds and prunes; slim `node:26-alpine` runtime
- Runtime command: `node dist/App.js` (explicit `CMD ["node", "dist/App.js"]`)
- Runs as `USER node` (UID 1000) and works with a read-only root filesystem; only `/tmp` needs a writable volume
- Production dependency tree is about 137 packages; config is mounted at `/opt/app/config.json` via a Kubernetes ConfigMap

## CI/CD

GitHub Actions workflows use reusable workflows from `devopsplaybook-io/common-utils`:

- `pr-check.yml` — runs on PR to `main`: version check, `npm ci`, build, lint, test, coverage upload, audit gate (high/critical production advisories) and Docker build/push of `beta-pr-<n>` and `beta`
- `main-build.yml` — runs on merge to `main`: audit and promotion of the exact PR-validated image to `0.9.0`, `0.9`, `0`, `latest` and `beta` (no rebuild)

## Post-Change Validation

After any change, run:

```bash
npm run build    # TypeScript compilation + spec type-check
npm run lint     # oxlint check
npm test         # Jest tests with coverage
```

All three must pass. Jest enforces global coverage thresholds of 85% statements, 80% branches, 85% functions and 85% lines (`jest.config.js`). Current numbers on `main`: 105 tests, 96.56% statements/lines, 90.81% branches, 100% functions.

For changes touching deployment examples or documentation paths, also verify the Kustomize output still builds:

```bash
kubectl kustomize docs/deployments/kubernetes/kubernetes
kubectl kustomize docs/deployments/kubernetes/kubernetes-nodeport
```

Other scripts: `npm run dev` (`tsx watch ./src/App.ts`) and `npm run dev:test` (Jest watch).
