# FluxCD Notifications OpenTelemetry Adapter - Agent Instructions

## Project Overview

A lightweight TypeScript server that receives FluxCD notification webhooks and forwards them as OpenTelemetry logs to a configured collector. It enables observability pipelines to capture GitOps reconciliation events (deployments, image updates, alerts) alongside application telemetry.

## Project Structure

```
fluxcd-notifications-otel-adapter/
  src/
    App.ts              # Entry point: Fastify server, route registration, OTel init
    Config.ts           # Extends ConfigBase from @devopsplaybook.io/common-utils
    OTelContext.ts       # Re-exports createOTelContext from common-utils
    App.spec.ts         # Route integration tests (Fastify inject)
    Config.spec.ts      # Config construction and reload delegation tests
    OTelContext.spec.ts # OTelContext wiring tests
  config.json           # Default runtime configuration (empty object)
  Dockerfile            # Multi-stage build (node:26-alpine)
```

## Coding Conventions

- **Language**: TypeScript (strict mode off, ES6 target, CommonJS modules)
- **Runtime**: Node.js 26
- **Build**: `tsc` compiles `src/` to `dist/` (with `skipLibCheck: true`)
- **Dev mode**: `ts-node-dev ./src/App.ts`
- **Tests**: Jest with `ts-jest`, spec files named `*.spec.ts` alongside source, run with `npm test`
- **Linting**: ESLint with `typescript-eslint` (strict + stylistic configs)
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

`src/Config.ts` extends `ConfigBase` with `serviceId = "fluxcd-notifications"`. It has no project-specific fields beyond what `ConfigBase` provides (OTel collector endpoints, log level, API port, etc.). The `reload()` method delegates to `super.reload()` with a logger callback.

### Request Flow

1. FluxCD sends a POST to `/` with body `{ message, reason, metadata: { cluster } }`
2. The adapter validates all three fields are present
3. A structured log line is emitted: `<cluster>: <reason> - <message>`
4. Returns `{ status: "ok" }` (200) or `{ error: "Bad Request" }` (400)
5. A health check is available at `GET /api/status` → `{ started: true }`

### Fastify Hooks

`StandardTracerFastifyRegisterHooks` is registered with `ignoreList: ["GET-/api/status"]` to avoid tracing health checks.

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
npm run lint     # ESLint check
npm test         # Jest tests with coverage
```

All three must pass. Coverage is currently at 100% for `Config.ts` and `OTelContext.ts`.
