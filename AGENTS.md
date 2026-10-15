# FluxCD Notifications OpenTelemetry Adapter - Agent Instructions

## Project Overview

A lightweight TypeScript server that receives FluxCD notification webhooks and forwards them as OpenTelemetry logs to a configured collector. It enables observability pipelines to capture GitOps reconciliation events (deployments, image updates, alerts) alongside application telemetry.

## Project Structure

```
fluxcd-notifications-otel-adapter/
  src/
    App.ts              # Entry point: Fastify server, OTel init, hooks registration
    AppRoutes.ts        # Route registration: status endpoint, Flux webhook forwarding
    Config.ts           # Extends ConfigBase from @devopsplaybook.io/common-utils
    OTelContext.ts       # Re-exports createOTelContext from common-utils
    App.spec.ts         # Route integration tests (Fastify inject on registerRoutes)
    Config.spec.ts      # Config construction and reload delegation tests
    OTelContext.spec.ts # OTelContext wiring tests
  config.json           # Default runtime configuration (empty object)
  Dockerfile            # Multi-stage build (node:26-alpine)
```

## Coding Conventions

- **Language**: TypeScript (strict mode off, ES6 target, CommonJS modules)
- **Runtime**: Node.js 26
- **Build**: `tsc` compiles `src/` to `dist/` (with `skipLibCheck: true`), then type-checks the spec files (`tsc -p tsconfig.spec.json --noEmit`)
- **Dev mode**: `tsx watch ./src/App.ts`
- **Tests**: Jest with `@swc/jest` (v8 coverage provider), spec files named `*.spec.ts` alongside source, run with `npm test`
- **Linting**: oxlint (recommended preset)
- **Config loading**: `Config` extends `ConfigBase` from `@devopsplaybook.io/common-utils`; env vars override config.json which overrides defaults
- **Secrets in logs**: Sensitive config values (authorization headers, keys) are masked as `********************` by `ConfigBase.reload()`

## Architecture

### Shared Libraries

This project consumes two shared libraries from `devopsplaybook.io/_libs/`:

- **`@devopsplaybook.io/common-utils`** — provides `ConfigBase` (config loading with env/file/default layering, type coercion, sensitive field masking) and `createOTelContext` (tracer/meter/logger singleton factory)
- **`@devopsplaybook.io/otel-utils-fastify`** — provides `StandardTracerFastifyRegisterHooks` for automatic request tracing via Fastify hooks

### OTelContext Pattern

`src/OTelContext.ts` calls `createOTelContext()` once at module load and re-exports the returned functions (`OTelTracer`, `OTelSetTracer`, `OTelMeter`, `OTelSetMeter`, `OTelLogger`, `OTelRequestSpan`). All other modules import from `./OTelContext` rather than creating their own context.

### Config Pattern

`src/Config.ts` extends `ConfigBase` with `serviceId = "fluxcd-notifications"`. Project-specific fields are registered with `addConfigField` in the constructor:

- `WEBHOOK_AUTHORIZATION_HEADER` — optional shared-secret check on `POST /` (sensitive, masked in logs)

The constructor also overrides `VERSION` with the application's `package.json` version (`ConfigBase` otherwise reports the shared library's version, which breaks release identification in telemetry). The `reload()` method delegates to `super.reload()` with a logger callback.

### Request Flow

1. FluxCD sends a POST to `/` with the Kubernetes Event object (severity, message, reason, involvedObject, metadata, reportingController, timestamp)
2. When `WEBHOOK_AUTHORIZATION_HEADER` is set, the request must carry the exact same `Authorization` header (401 otherwise)
3. Payloads without a non-empty `message` and `reason` are rejected with 400, counted in `rejected_events_total{reason="invalid_payload"}` and logged as WARN with a short payload excerpt
4. Accepted events are forwarded as one raw OTel log record via `StandardLogger.getLogger().emit()`: severity mapped from Flux severity (info→INFO, error→ERROR, warn/warning→WARN, else INFO), human-readable body `<cluster>: <reason> - <message>` (cluster defaults to `unknown` when `metadata.cluster` is missing), and `flux.*` attributes (cluster, reason, severity, object kind/name/namespace/apiVersion/uid, revision, reporting_controller) with the request OTel context attached
5. Events are counted in `events_total{cluster, reason, severity}`; when no OTel logger is configured (no logs collector endpoint) the event is only printed to the console
6. A health check is available at `GET /api/status` → `{ started: true, version: "<version>" }`

### Fastify Hooks

`StandardTracerFastifyRegisterHooks` is registered with `rootApiPath: "/"` so webhook requests to `POST /` are traced (the default `/api` root silently skips them), and `ignoreList: ["GET-/api/status"]` to avoid tracing health checks.

## Configuration

All config is loaded by `Config.reload()` in this priority order:

1. Environment variables (highest priority)
2. `config.json` file
3. `ConfigBase` class defaults

Key inherited configuration values from `ConfigBase`:

- `API_PORT` — HTTP listen port (default: `8080`)
- `LOG_LEVEL` — logging verbosity (default: `info`)
- `OPENTELEMETRY_COLLECTOR_HTTP_TRACES` — OTel collector traces endpoint
- `OPENTELEMETRY_COLLECTOR_HTTP_METRICS` — OTel collector metrics endpoint
- `OPENTELEMETRY_COLLECTOR_HTTP_LOGS` — OTel collector logs endpoint
- `OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS` — log export interval
- `OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS` — metrics export interval
- `OPENTELEMETRY_COLLECTOR_AWS` — enable AWS-specific OTel config (default: `false`)
- `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER` — auth header for OTel collector (sensitive, masked in logs)

Project-specific configuration values:

- `WEBHOOK_AUTHORIZATION_HEADER` — when set, `POST /` requires the exact same `Authorization` header (401 otherwise); empty by default (no auth)

Special environment variable:

- `FASTIFY_LOG_LEVEL` — when set (truthy), enables Fastify's internal request logging

## Docker

- Multi-stage build: `node:26-alpine` builder compiles TypeScript, slim runtime stage
- Runtime command: `node dist/App.js`
- Config is mounted at `/opt/app/config.json` via Kubernetes ConfigMap

## CI/CD

GitHub Actions workflows use reusable workflows from `devopsplaybook-io/common-utils`:

- `pr-check.yml` — runs on PR to `main`: build, lint, test
- `main-build.yml` — runs on merge to `main`: build, lint, test, publish Docker image to Docker Hub

Both workflows upload quality reports to the quality dashboard.

## Post-Change Validation

After any code change, run:

```bash
npm run build    # TypeScript compilation
npm run lint     # oxlint check
npm test         # Jest tests with coverage
```

All three must pass. Coverage is currently at 100% statements for `src/`.
