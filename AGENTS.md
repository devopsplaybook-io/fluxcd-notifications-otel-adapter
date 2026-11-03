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
    RejectionLogSampler.ts # Bounded per-key 60 s sampler for rejection log lines
    TrustProxy.ts         # Validates TRUST_PROXY into a Fastify trustProxy setting
    OTelContext.ts        # Calls createOTelContext() once and re-exports its accessors
    App.spec.ts           # Route integration tests (Fastify inject on registerRoutes)
    AppLifecycle.spec.ts  # Startup/shutdown and signal handling tests
    AppMetrics.spec.ts    # Metric emission tests
    Config.spec.ts        # Config construction and reload delegation tests
    OTelContext.spec.ts   # OTelContext wiring tests
    RateLimiter.spec.ts   # Rate limiter tests
    RejectionLogSampler.spec.ts # Rejection log sampler tests
    TrustProxy.spec.ts    # TRUST_PROXY parsing tests
  config.json             # Default runtime configuration (empty object)
  .nvmrc                  # Node.js 26 (matches engines and node:26-alpine)
  Dockerfile              # Multi-stage build (node:26-alpine)
  docs/                   # Deployment examples (Kubernetes/Kustomize with NetworkPolicy, Docker Compose)
```

## Coding Conventions

- **Language**: TypeScript (strict mode off, ES6 target, CommonJS modules); enabling strict mode is a separate future change, not part of a bug fix or feature PR
- **Runtime**: Node.js 26 (`engines.node >= 26` in `package.json`, `.nvmrc`)
- **Build**: `tsc` compiles `src/` to `dist/` (with `skipLibCheck: true`), then type-checks the spec files (`tsc -p tsconfig.spec.json --noEmit`)
- **Dev mode**: `tsx watch ./src/App.ts`
- **Tests**: Jest with `@swc/jest` (v8 coverage provider), spec files named `*.spec.ts` alongside source, run with `npm test`
- **Linting**: oxlint (recommended preset)
- **Config loading**: `Config` extends `ConfigBase` from `@devopsplaybook.io/common-utils/config`; env vars override config.json which overrides defaults. The configuration is loaded **once** at startup and there is **no reload or file watcher**: every change requires a process/rollout restart.
- **Secrets in logs**: Sensitive config values (authorization headers, keys) are masked as `********************` by `ConfigBase.reload()`

## Architecture

### Shared Libraries

This project consumes two shared libraries from `devopsplaybook.io/_libs/`:

- **`@devopsplaybook.io/common-utils`** — provides `ConfigBase` (config loading with env/file/default layering, type coercion, sensitive field masking) and `createOTelContext` (tracer/meter/logger singleton factory)
- **`@devopsplaybook.io/otel-utils-fastify`** — provides `StandardTracerFastifyRegisterHooks` for automatic request tracing via Fastify hooks

Always import from the subpaths, never the barrel: `ConfigBase` from `@devopsplaybook.io/common-utils/config` and `createOTelContext` from `@devopsplaybook.io/common-utils/otel`. The barrel would also load the full database and authentication stack (better-sqlite3, pg, bcrypt, jsonwebtoken, axios) even though this adapter uses none of it; the subpaths keep startup at ~328 modules / ~112 ms for `Config` + `OTelContext` (a full `dist/App.js` import is ~473 modules / ~155 ms) instead of ~560 / ~223 ms and ~658 / ~257 ms.

`npm ci` still needs native build tooling because `common-utils` declares those DB modules as regular dependencies, so they are installed and compiled; the subpath imports never load them at runtime.

### OTelContext Pattern

`src/OTelContext.ts` calls `createOTelContext()` once at module load and re-exports the returned functions (`OTelTracer`, `OTelSetTracer`, `OTelMeter`, `OTelSetMeter`, `OTelLogger`). All other modules import from `./OTelContext` rather than creating their own context. `OTelRequestSpan` and `OTelRequestContext` are **not** re-exported: they come from `@devopsplaybook.io/otel-utils-fastify`.

### Config Pattern

`src/Config.ts` extends `ConfigBase` with `serviceId = "fluxcd-notifications"`. Project-specific fields are registered with `addConfigField` in the constructor:

- `WEBHOOK_AUTHORIZATION_HEADER` — optional shared-secret check on `POST /` (sensitive, masked in logs)
- `WEBHOOK_AUTH_REQUIRED` — boolean, default `false`: when `true`, startup refuses to continue if `WEBHOOK_AUTHORIZATION_HEADER` is empty (fail closed); when `false`, an empty header only logs a warning (backward-compatible fail-open)
- `WEBHOOK_RATE_LIMIT_PER_MINUTE` — per-client-IP limit on every route, default `600`, `0` disables the limiter
- `TRUST_PROXY` — Fastify client-IP model, empty by default (direct peer); `true` or a comma-separated list of IPs/CIDRs/keywords (`loopback`, `linklocal`, `uniquelocal`); an invalid value fails startup
- `OPENTELEMETRY_CONSOLE_LOG_MODE` — console mirroring for module-logger records, default `always`; `fallback` mirrors only when no logs endpoint is configured, `never` suppresses; an invalid value behaves like `always`. Applies to accepted-event lines and, through the module logger, rejection lines

The constructor also overrides `VERSION` with the application's `package.json` version (`ConfigBase` otherwise reports the shared library's version, which breaks release identification in telemetry). The `reload()` method delegates to `super.reload()` with a logger callback; it is only called during startup.

### Request Flow

1. FluxCD sends a POST to `/` with the Kubernetes Event object (severity, message, reason, involvedObject, metadata, reportingController, timestamp)
2. Rate limiting runs first in the Fastify `onRequest` phase, before body parsing and before authentication. The limiter is a **root hook**, so it covers every route including `/api/status` and unknown routes (404s): `WEBHOOK_RATE_LIMIT_PER_MINUTE` per client IP in a fixed 60 s window (at most 10 000 tracked clients); over the limit → `429` + `Retry-After`, counted as `rate_limited`. The bucket key is the resolved client IP (never the shared authorization token); with `TRUST_PROXY` set, `request.ip` comes from `X-Forwarded-For` only for trusted peers, and a malformed value falls back to the socket address
3. Authentication runs in the same `onRequest` phase, still before body parsing: when `WEBHOOK_AUTHORIZATION_HEADER` is set, the request must carry the exact same `Authorization` header (timing-safe, `401` + `WWW-Authenticate: Bearer` otherwise). An unauthenticated malformed or oversized body therefore gets `401`, not `400`/`413`. Authentication is active whenever the header is set regardless of `WEBHOOK_AUTH_REQUIRED`; the switch only adds a fail-closed startup guard (refuses to start when required but the header is empty). The authorization headers are secrets provided as environment variables (in Kubernetes via `secretKeyRef` from a Secret), never from `config.json` or a ConfigMap
4. Fastify rejects oversized bodies (`413`, 64 KiB limit) and unsupported content types (`415`) before the handler runs
5. The handler requires only a non-empty `message`: a missing/blank message is `400 invalid_payload`. `reason` and `metadata.cluster` default to `unknown`; a non-string `severity` is treated as absent (`unknown`) without failing the request
6. Accepted events are emitted as one OTel log record via `StandardLogger.getLogger().emit()` when a logs endpoint is configured: severity mapped from the Flux severity (info→INFO, error→ERROR, warn/warning→WARN, else INFO), body `<cluster>: <reason> - <message>`, and `flux.*` attributes (cluster, reason, severity, object kind/name/namespace/apiVersion/uid, revision, reporting_controller, `flux.message.truncated`, `flux.attributes.truncated` when applicable) with the request OTel context attached. A console line `[level] [fluxcd-notifications] <body>` is printed unless `OPENTELEMETRY_CONSOLE_LOG_MODE` is `fallback` with a logs endpoint configured or `never` (info → stdout, warn/error → stderr); with no logs endpoint the event goes to the console only through the module logger, which honours the same mode. Every input-derived string attribute is capped at 256 code points (code-point aware, never splitting a surrogate pair)
7. Events are counted in `events_total{cluster, reason, severity}`; counters are only exported when a metrics endpoint is configured
8. The response is `{"status":"ok"}`; a health check is available at `GET /api/status` → `{ started: true, version: "<version>" }`

Rejection reasons counted exactly once in `rejected_events_total{reason}`: `invalid_payload` (400), `invalid_json` (400), `unauthorized` (401), `bad_request` (404 and other 4xx), `payload_too_large` (413), `unsupported_media_type` (415), `rate_limited` (429). Each rejection always increments the counter, but its log line is sampled: at most once per HTTP method (unknown methods collapse to `OTHER`), registered route template (`unmatched` for 404s), status and reason per rolling 60 s window; later events are reported as `suppressed=<n>` on the next line. 404s log at INFO, other rejections at WARN. The logged route is method + path without the query string. `invalid_payload` logs structure/type tokens only (`body_type=object key_count=… has_message=… message_type=…`), never key names or values; `invalid_json` logs no body. 5xx responses are logged at ERROR (with message and code) and are **not** counted as rejections; their response body is a fixed generic `{statusCode, error: "Internal Server Error"}`, never the thrown message/code.

### Severity

`flux.severity` on the log record keeps the trimmed, lower-cased raw value (`unknown` when absent, arbitrary values such as `critical` preserved). A non-string value (number, boolean, object, array, null) is treated as absent, not rejected. Only the metric `severity` label is normalized to `info|warn|error|unknown`. Log severity: info→INFO, error→ERROR, warn/warning→WARN, anything else→INFO.

### Fastify Hooks and Limits

`StandardTracerFastifyRegisterHooks` is registered with `rootApiPath: "/"` so webhook requests to `POST /` are traced (the default `/api` root silently skips them), `ignoreList: ["GET-/api/status"]` to avoid tracing health checks, and `unmatchedRouteSpanName: "method"` so 404/429 spans are named `GET`/`POST` instead of attacker-controlled paths. `registerRoutes` is called **before** the tracing hooks so the global rate limiter runs first: a 429 short-circuits before a span is created. Routes, 404 handling and the limiter therefore all share the per-client bucket.

`TRUST_PROXY` is resolved by `src/TrustProxy.ts` and passed to Fastify `trustProxy`; startup logs the resulting client-IP model (direct peer, trust all forwarded headers, or trusted proxy ranges).

Fixed Fastify limits (`src/App.ts`): body 64 KiB, connection timeout 10 s, request timeout 15 s, keep-alive timeout 72 s. Shutdown closes the HTTP server and flushes telemetry under a single 10 s bound (exit 1 when either fails, 0 on a clean or timed-out shutdown). The log queue is 2 048 records; a worst-case record is ~75 KiB (16 384-code-point message up to ~64 KiB UTF-16 plus ~10 KiB of 256-code-point attributes), so a full queue can retain roughly 150 MiB and an in-flight export a second copy (~300 MiB). `otel-utils-fastify` additionally logs one WARN per client error (`statusCode < 500`), so a malformed/oversized body produces a library line plus the adapter's sampled record.

### Graceful Shutdown

On `SIGTERM`/`SIGINT` the server stops accepting requests, closes Fastify and flushes logs/traces/metrics under one 10 s bound: it exits 1 when the close or a flush fails and 0 on a clean shutdown or when the bound is reached; a second signal exits immediately with code 1.

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
- `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER` — token sent to the collector as `Authorization: Bearer <value>` (sensitive, masked in logs); a secret: environment variable only (Kubernetes Secret), never in a config file

Project-specific configuration values:

- `WEBHOOK_AUTHORIZATION_HEADER` — when set, `POST /` requires the exact same `Authorization` header (401 otherwise); empty by default (no auth, startup warning); a secret: environment variable only (Kubernetes Secret via `secretKeyRef`), never in a config file or ConfigMap
- `WEBHOOK_AUTH_REQUIRED` — boolean, default `false`; when `true`, startup refuses to continue if `WEBHOOK_AUTHORIZATION_HEADER` is empty (fail closed); when `false`, an empty header only logs a warning (backward-compatible fail-open)
- `WEBHOOK_RATE_LIMIT_PER_MINUTE` — per-client-IP limit over a fixed 60 s window on every route; default `600`, `0` disables
- `TRUST_PROXY` — client-IP model; empty by default (direct peer), `true` (trusts every `X-Forwarded-For`), or a comma-separated list of trusted proxy IPs/CIDRs/keywords
- `OPENTELEMETRY_CONSOLE_LOG_MODE` — console mirroring for accepted events and module-logger records; default `always`, `fallback` only without a logs endpoint, `never` suppresses; an invalid value behaves like `always`

## Docker

- Multi-stage build: `node:26-alpine` builder installs `python3 perl alpine-sdk` to compile native modules (bash/git are not needed: there are no git-resolved dependencies), then builds and prunes; slim `node:26-alpine` runtime. The runtime image still contains the unused better-sqlite3/bcrypt/pg modules because `common-utils` declares them; removing them requires a shared-library change
- Runtime command: `node dist/App.js` (explicit `CMD ["node", "dist/App.js"]`)
- Runs as `USER node` (UID 1000) and works with a read-only root filesystem; only `/tmp` needs a writable volume
- Production dependency tree is about 137 packages; config is mounted at `/opt/app/config.json` via a Kubernetes ConfigMap
- Kubernetes examples inject the authorization headers from a Secret via `secretKeyRef` (`WEBHOOK_AUTHORIZATION_HEADER` mandatory — the pod fails with `CreateContainerConfigError` until the Secret exists; `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER` optional) and include a NetworkPolicy restricting ingress on port 8080 to the Flux notification-controller (namespace `flux-system`, pod label `app: notification-controller`); kubelet probe traffic is exempt from NetworkPolicy, so `/api/status` probes keep working, and the NodePort overlay is blocked by the policy until an explicit allow rule is added

## CI/CD

GitHub Actions workflows use reusable workflows from `devopsplaybook-io/common-utils`:

- `pr-check.yml` — runs on PR to `main`: version check, `npm ci`, build, lint, test, coverage upload, audit gate (high/critical production advisories) and Docker build/push of `beta-pr-<n>` and `beta`
- `main-build.yml` — runs on merge to `main`: audit and promotion of the exact PR-validated image to `0.14.0`, `0.14`, `0`, `latest` and `beta` (no rebuild)

## Post-Change Validation

After any change, run:

```bash
npm run build    # TypeScript compilation + spec type-check
npm run lint     # oxlint check
npm test         # Jest tests with coverage
```

All three must pass. Jest enforces global coverage thresholds of 85% statements, 80% branches, 85% functions and 85% lines (`jest.config.js`). Current numbers on `main`: 207 tests, 98.09% statements/lines, 94.13% branches, 100% functions.

For changes touching deployment examples or documentation paths, also verify the Kustomize output still builds:

```bash
kubectl kustomize docs/deployments/kubernetes/kubernetes
kubectl kustomize docs/deployments/kubernetes/kubernetes-nodeport
```

Other scripts: `npm run dev` (`tsx watch ./src/App.ts`) and `npm run dev:test` (Jest watch).
