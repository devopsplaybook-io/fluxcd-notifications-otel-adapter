# FluxCD Notifications OpenTelemetry Adapter

FluxCD Notifications OpenTelemetry Adapter is a lightweight server that receives FluxCD notification webhooks and forwards them as OpenTelemetry logs to a configured collector. It lets observability pipelines capture GitOps reconciliation events (deployments, image updates, alerts) alongside application telemetry in a unified backend.

## How events are forwarded

An accepted webhook event is emitted as **one OpenTelemetry log record when `OPENTELEMETRY_COLLECTOR_HTTP_LOGS` is set**. Every accepted event also prints a console line in the pod logs, unless `OPENTELEMETRY_CONSOLE_LOG_MODE` suppresses it (`fallback` with a collector configured, or `never`):

```text
[info] [fluxcd-notifications] my-cluster: ReconciliationSucceeded - Reconciliation finished in 1.2s
```

The body of the console line is `<cluster>: <reason> - <message>`, prefixed with the mapped log level (`info`, `warn` or `error`) and the fixed module name `fluxcd-notifications`. Info lines go to stdout, warn and error lines to stderr.

`OPENTELEMETRY_CONSOLE_LOG_MODE` controls this mirroring: `always` (default) prints the line whether or not a collector is configured; `fallback` prints it only when no logs endpoint is configured; `never` suppresses it. An invalid value behaves like `always`. With no logs endpoint configured, no record is exported: the same line is printed through the internal module logger, which is the console-only fallback and honours the same mode. Metrics and traces have their own optional endpoints (see [Metrics](#metrics)).

Delivery semantics:

- **At-most-once from the adapter.** Events are not persisted, deduplicated or replayed. A crash, a restart or an exhausted shutdown bound loses buffered records.
- **Batched, best-effort export.** Records sit in an in-memory queue of 2 048 entries. They are exported when 512 records accumulate or when `OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS` elapses (default 60 s), whichever comes first. Each export attempt is bounded to 30 s. The OpenTelemetry SDK may retry a transient export failure, so a lost response can duplicate a batch even though the adapter emits each event once. A worst-case record is a 16 384-code-point message (up to ~64 KiB of UTF-16 data) plus ~10 KiB of 256-code-point attributes and record overhead (~75 KiB): a full queue can retain roughly 150 MiB, and an in-flight export can hold a second copy (~300 MiB).
- **Bounded graceful shutdown.** On `SIGTERM` or `SIGINT` the adapter stops accepting requests, closes the HTTP server, then flushes logs, traces and metrics with a **10 s bound** and exits 0. A second signal during shutdown exits immediately with code 1. Records still buffered when the bound is reached are lost.
- **Timestamp.** A valid RFC3339 `timestamp` between 2000-01-01 and one hour in the future is used as the record timestamp; otherwise the receipt time is used.

## Severity mapping

The raw event severity is mapped to the OTel severity, kept on the log record, and normalized for the metric label:

| Event `severity`           | OTel severity | `flux.severity` log attribute | Metric `severity` label |
| -------------------------- | ------------- | ----------------------------- | ----------------------- |
| `info`                     | INFO          | `info`                        | `info`                  |
| `error`                    | ERROR         | `error`                       | `error`                 |
| `warn` / `warning`         | WARN          | `warn`                        | `warn`                  |
| absent                     | INFO          | `unknown`                     | `unknown`               |
| any other, e.g. `critical` | INFO          | `critical`                    | `unknown`               |
| a non-string, e.g. `42`    | INFO          | `unknown`                     | `unknown`               |

`flux.severity` holds the trimmed, lower-cased raw value (or `unknown` when absent) and is **not** limited to four values. A non-string value is treated as absent (`unknown`) instead of failing the request. Only the metric label is normalized to `info`, `warn`, `error` or `unknown`.

## Log record body and attributes

The record body is `<cluster>: <reason> - <message>`. Structured attributes:

| Attribute                   | Description                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `flux.cluster`              | Cluster name from `metadata.cluster`; `unknown` when absent; truncated to 256 code points                 |
| `flux.reason`               | Event reason; `unknown` when absent; truncated to 256 code points                                         |
| `flux.severity`             | Trimmed, lower-cased raw severity; `unknown` when absent; truncated to 256 code points                    |
| `flux.object.kind`          | `involvedObject.kind` of the affected resource, when present; truncated to 256 code points                 |
| `flux.object.name`          | `involvedObject.name` of the affected resource, when present; truncated to 256 code points                 |
| `flux.object.namespace`     | `involvedObject.namespace` of the affected resource, when present; truncated to 256 code points            |
| `flux.object.apiVersion`    | `involvedObject.apiVersion` of the affected resource, when present; truncated to 256 code points           |
| `flux.object.uid`           | `involvedObject.uid` of the affected resource, when present; truncated to 256 code points                  |
| `flux.revision`             | Artifact revision from the `…/revision` metadata keys, when present; truncated to 256 code points          |
| `flux.reporting_controller` | `reportingController` of the emitting Flux controller, when present; truncated to 256 code points           |
| `flux.message.truncated`    | `true` only when the message exceeded 16 384 code points and was truncated                                  |
| `flux.attributes.truncated` | `true` only when a non-message input attribute was truncated to 256 code points                             |
| `trace.id` / `span.id`      | Request trace/span correlation attributes added when a logs endpoint is configured; joinable to a trace only when a traces endpoint is also configured (see below) |

Every input-derived string attribute is capped at 256 code points; truncation never splits a surrogate pair. Truncation of a non-message attribute sets `flux.attributes.truncated=true`.

When metadata carries several `…/revision` keys, the kustomize, helm, source then notification revision is used, in that order, followed by the alphabetically first remaining key.

otel-light correlates adapter logs with traces through the `trace.id` and `span.id` **attributes**, not the OTLP trace/span identifiers on the record. The attributes are populated from the request span whenever a logs endpoint is set — even if no traces endpoint is configured — but without `OPENTELEMETRY_COLLECTOR_HTTP_TRACES` no spans are exported anywhere, so the IDs cannot be joined to a trace; they only support log↔trace correlation once a traces endpoint exists.

## Accepted payload

Only `message` is mandatory: it must be a non-empty string after trimming. `reason` and `metadata.cluster` may be absent or blank and default to `unknown`. Other fields are optional:

- `severity`, `timestamp`, `reportingController`
- `involvedObject.{kind,name,namespace,apiVersion,uid}`
- `metadata` (including `metadata.cluster` and the `…/revision` keys)

Limits: `message` is truncated at 16 384 code points (16 KiB, up to ~64 KiB of UTF-16 data) with `flux.message.truncated=true`; every other input-derived string attribute (`reason`, `cluster`, `severity`, `involvedObject.*`, `revision`, `reportingController`) is truncated at 256 code points with `flux.attributes.truncated=true`. Truncation counts Unicode code points, so it never splits a surrogate pair.

## Rejected requests

Each rejected request is counted exactly once in `rejected_events_total{reason}`:

| Status    | `reason` label          | Trigger                                                                   |
| --------- | ----------------------- | ------------------------------------------------------------------------- |
| 400       | `invalid_payload`       | Body is not a JSON object, or `message` is missing/blank                   |
| 400       | `invalid_json`          | Malformed JSON body                                                       |
| 401       | `unauthorized`          | `WEBHOOK_AUTHORIZATION_HEADER` is set and the exact header is missing/wrong |
| 404       | `bad_request`           | Unknown route                                                             |
| 413       | `payload_too_large`     | Body larger than 64 KiB                                                   |
| 415       | `unsupported_media_type`| Unsupported content type                                                  |
| 429       | `rate_limited`          | Rate limit exceeded (see below)                                           |
| other 4xx | `bad_request`           | Any other client error                                                    |

Rejection **logs are sampled; the metric is exact.** `rejected_events_total` increments once per rejected request (a `WeakSet` prevents double counting), so counting and alerting on rejections is unaffected. The log line `Webhook request rejected: route=… status=… reason=…` is emitted at most once per sampling key per rolling 60 s window, where the key is the HTTP method (unknown methods collapse to `OTHER`), the registered route template (`unmatched` for unknown routes), the status and the reason. Later events in the window are counted as suppressed and reported on the next line as `suppressed=<n>`. This bounds log, trace and metric volume during a flood.

- Unknown routes (404) log the sampled line at **INFO**, not WARN.
- The logged route is the method and path with the query string removed, sanitized and truncated to 120 characters, so credentials in a query string are never logged.
- `invalid_payload` logs the body **structure and types only** (`body_type=object key_count=2 has_message=true message_type=string`, or `body_type=null|array|string|…`): never key names, excerpts or values, because a rejected body can contain credentials. `invalid_json` deliberately logs no body.
- Console rendering strips ANSI escape sequences and control characters so an event cannot forge log lines; the OTel record keeps the raw values.

Server errors (5xx) are logged at ERROR and are **not** counted as rejections. A 5xx response always carries a fixed generic body (`{"statusCode": <code>, "error": "Internal Server Error"}`); the error message and code stay in the server logs, never in the response. Informative 4xx bodies are unchanged.

Rate limiting and authentication both run in the Fastify `onRequest` phase, before the body is parsed:

- The limiter is a **root `onRequest` hook**, so it covers every route, including `/api/status`, unknown routes (404) and any future route; a flood is rejected with `429` before tracing or body parsing.
- `WEBHOOK_RATE_LIMIT_PER_MINUTE` defaults to **600** per client IP; `0` disables the limiter. A rejected request gets `429` with a `Retry-After` header and counts as `rate_limited`; it wins over `401` on `POST /`.
- The bucket key is the resolved client IP (`request.ip` when it is a valid IP, otherwise the socket address, otherwise `unknown`). It is **never** the authorization token: that token is shared by every Flux event, so keying on it would create one global bucket.
- `TRUST_PROXY` controls how the client IP is derived (see [Configuration](#configuration) and [Securing the webhook endpoint](#securing-the-webhook-endpoint)).

Limiter properties to account for when sizing it (a documented trade-off, not a guarantee):

- The fixed 60 s window is anchored to each client's first request, not to wall-clock minutes: a client can spend the full limit late in one window and the full limit again right after the boundary, so up to **2× the limit** can pass across a boundary.
- On overflow (more than 10 000 tracked clients) the limiter scans the whole map, purges expired windows, then evicts the oldest window; eviction resets that client's counter. The cap bounds memory, it is not a hard global limit.
- There is **no global cap**: worst-case admitted traffic is approximately tracked clients × limit per minute, so also rate-limit at the ingress.

`otel-utils-fastify` logs client errors (`statusCode < 500`) once per request from its `onError` hook. A malformed JSON, oversized or unsupported body therefore produces a library WARN **plus** the adapter's own sampled record. This is bounded by the now-global limiter and by the log queue sizing; version 1.7.1 has no option to disable the library line, and the adapter's own record must not be silenced because it carries the rejection reason.

## Metrics

The adapter creates two OTLP counters, exported **only when `OPENTELEMETRY_COLLECTOR_HTTP_METRICS` is set** (this is not a Prometheus exposition endpoint):

- `fluxcd-notifications.events_total{cluster, reason, severity}` — accepted events,
- `fluxcd-notifications.rejected_events_total{reason}` — rejected requests.

Metric labels are low-cardinality and bounded:

- `cluster` is trimmed, unsupported characters (`[^A-Za-z0-9_.:-]`) become `_`, case is preserved;
- `reason` is trimmed, lower-cased and sanitized the same way;
- `severity` is `info`, `warn`, `error` or `unknown`;
- every label value falls back to `unknown` when empty and is capped at 64 characters.

No per-object metrics are emitted.

## Quick start

Deploy the adapter (see [Installation](#installation)), then point Flux at it. Create a `Provider` of type `generic` and an `Alert` — the `eventMetadata.cluster` value is what populates `flux.cluster`:

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: otel-adapter
  namespace: flux-system
spec:
  type: generic
  address: http://fluxcd-notifications-otel-adapter.fluxcd-notifications-otel-adapter.svc.cluster.local:8080/
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: otel-adapter
  namespace: flux-system
spec:
  providerRef:
    name: otel-adapter
  eventSeverity: info
  eventSources:
    - kind: Kustomization
      name: "*"
  eventMetadata:
    cluster: my-cluster
```

Test the webhook directly with `curl`:

```bash
curl -s -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -d '{
    "severity": "info",
    "reason": "ReconciliationSucceeded",
    "message": "Reconciliation finished in 1.2s",
    "involvedObject": {"kind": "Kustomization", "name": "apps", "namespace": "flux-system"},
    "metadata": {"cluster": "my-cluster", "kustomize.toolkit.fluxcd.io/revision": "main@sha1:0123456789abcdef"}
  }'
# {"status":"ok"}
```

With webhook authentication enabled, add the matching header to the request: `-H "Authorization: Bearer <shared-secret>"` (see [Securing the webhook endpoint](#securing-the-webhook-endpoint)); without it the request is rejected with `401`.

The adapter prints `[info] [fluxcd-notifications] my-cluster: ReconciliationSucceeded - Reconciliation finished in 1.2s` to the pod logs unless `OPENTELEMETRY_CONSOLE_LOG_MODE` is `fallback` with a collector configured or `never`. When a logs endpoint is configured, the collector also receives an INFO record with that body and the `flux.*` attributes listed above, so failed reconciliations (`severity: error`) show up as ERROR records filterable by cluster, object and reason. Without a logs endpoint, the console line is the only output.

## Installation

This adapter is meant to be deployed alongside your FluxCD installation in Kubernetes.

The Kustomize base in [docs/deployments/kubernetes/kubernetes](docs/deployments/kubernetes/kubernetes) is the authoritative example; the [kubernetes-nodeport](docs/deployments/kubernetes/kubernetes-nodeport) overlay changes only the Service type. It deploys the image pinned to `0.13.0`, enables the logs collector, leaves the traces and metrics endpoints empty, requires the webhook Secret to be created before applying the manifests (`WEBHOOK_AUTH_REQUIRED=true`) and includes a NetworkPolicy (see [Securing the webhook endpoint](#securing-the-webhook-endpoint)).

### Kustomize

```bash
git clone https://github.com/devopsplaybook-io/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/kubernetes/kubernetes
kubectl kustomize . | kubectl apply -f -
```

### Plain manifests

The following manifests are equivalent to the Kustomize base. The authorization headers come from a Secret, so create it **before** applying the Deployment — the container references it with `secretKeyRef` and stays in `CreateContainerConfigError` until the Secret exists:

```bash
kubectl apply -f namespace.yaml
kubectl -n fluxcd-notifications-otel-adapter create secret generic \
  fluxcd-notifications-otel-adapter-secret \
  --from-literal=WEBHOOK_AUTHORIZATION_HEADER='Bearer <shared-secret>'
# Optional collector token:
# kubectl -n fluxcd-notifications-otel-adapter patch secret fluxcd-notifications-otel-adapter-secret \
#   -p '{"stringData":{"OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER":"<collector-token>"}}'
```

```yaml
# namespace.yaml
kind: Namespace
apiVersion: v1
metadata:
  name: fluxcd-notifications-otel-adapter
  labels:
    name: fluxcd-notifications-otel-adapter
---
# serviceaccount.yaml
# The adapter needs no Kubernetes API access: no RBAC roles are required.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fluxcd-notifications-otel-adapter
  namespace: fluxcd-notifications-otel-adapter
---
# configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluxcd-notifications-otel-adapter-config
  namespace: fluxcd-notifications-otel-adapter
data:
  config.json: |
    {
      "OPENTELEMETRY_COLLECTOR_HTTP_TRACES": "",
      "OPENTELEMETRY_COLLECTOR_HTTP_METRICS": "",
      "OPENTELEMETRY_COLLECTOR_HTTP_LOGS": "http://otel-light.otel-light.svc.cluster.local:8080/v1/logs",
      "OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS": "60",
      "OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS": "60",
      "WEBHOOK_AUTH_REQUIRED": true,
      "TRUST_PROXY": ""
    }
---
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fluxcd-notifications-otel-adapter
  namespace: fluxcd-notifications-otel-adapter
  labels:
    app: fluxcd-notifications-otel-adapter
spec:
  replicas: 1
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: fluxcd-notifications-otel-adapter
  template:
    metadata:
      labels:
        app: fluxcd-notifications-otel-adapter
    spec:
      serviceAccountName: fluxcd-notifications-otel-adapter
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 45
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - image: devopsplaybookio/fluxcd-notifications-otel-adapter:0.13.0
          name: fluxcd-notifications-otel-adapter
          # Authorization headers are secrets: they must come from a Secret
          # (secretKeyRef), never from a ConfigMap or config.json.
          env:
            - name: WEBHOOK_AUTHORIZATION_HEADER
              valueFrom:
                secretKeyRef:
                  name: fluxcd-notifications-otel-adapter-secret
                  key: WEBHOOK_AUTHORIZATION_HEADER
            - name: OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER
              valueFrom:
                secretKeyRef:
                  name: fluxcd-notifications-otel-adapter-secret
                  key: OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER
                  optional: true
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          resources:
            limits:
              memory: 500Mi
              cpu: 1
            requests:
              memory: 20Mi
              cpu: 100m
          volumeMounts:
            - name: config-volume
              mountPath: /opt/app/config.json
              subPath: config.json
            - name: tmp-volume
              mountPath: /tmp
          imagePullPolicy: Always
          startupProbe:
            httpGet:
              path: /api/status
              port: 8080
            periodSeconds: 5
            failureThreshold: 30
            timeoutSeconds: 3
          livenessProbe:
            httpGet:
              path: /api/status
              port: 8080
            periodSeconds: 15
            failureThreshold: 3
            timeoutSeconds: 3
          readinessProbe:
            httpGet:
              path: /api/status
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 3
      volumes:
        - name: config-volume
          configMap:
            name: fluxcd-notifications-otel-adapter-config
        - name: tmp-volume
          emptyDir:
            sizeLimit: 16Mi
---
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: fluxcd-notifications-otel-adapter
  namespace: fluxcd-notifications-otel-adapter
spec:
  type: ClusterIP
  ports:
    - name: tcp
      port: 8080
      targetPort: 8080
  selector:
    app: fluxcd-notifications-otel-adapter
---
# networkpolicy.yaml
# Only the Flux notification-controller may reach the webhook port. Kubelet
# probe traffic to/from the pod's node is exempt from NetworkPolicy, so the
# /api/status probes keep working; NetworkPolicy cannot restrict by HTTP path.
# Adjust the namespace/pod labels if Flux is installed elsewhere.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: fluxcd-notifications-otel-adapter
  namespace: fluxcd-notifications-otel-adapter
spec:
  podSelector:
    matchLabels:
      app: fluxcd-notifications-otel-adapter
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: flux-system
          podSelector:
            matchLabels:
              app: notification-controller
      ports:
        - protocol: TCP
          port: 8080
```

Notes:

- Replace the `OPENTELEMETRY_COLLECTOR_HTTP_LOGS` URL with your collector. The example logs only; traces and metrics endpoints stay empty unless you need them.
- Add `WEBHOOK_RATE_LIMIT_PER_MINUTE` (default `600`), `WEBHOOK_AUTH_REQUIRED` (default `false`) or `TRUST_PROXY` (default empty) to the `config.json` key, or set them as environment variables on the container, to change the matching defaults. The two authorization headers (`WEBHOOK_AUTHORIZATION_HEADER`, `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`) are secrets: provide them only as environment variables — from a Kubernetes Secret via `secretKeyRef`/`envFrom`, or the shell/`.env` file with Docker Compose — never in a ConfigMap or `config.json`.
- Configuration is read once at startup and there is **no live reload**. After changing the ConfigMap or the environment, run `kubectl rollout restart deployment/fluxcd-notifications-otel-adapter`.
- The ConfigMap is mounted with `subPath` because there is no live reload; that is also why ConfigMap updates are not picked up in place.
- `GET /api/status` reports `{"started": true, "version": "<version>"}` and is used by the probes.

A Docker Compose example is provided in [docs/deployments/docker-compose](docs/deployments/docker-compose).

## Configuration

Configuration can be provided as environment variables or through `config.json`. Precedence: **environment variables > `config.json` > defaults**.

| Parameter                                               | Description                                                                 | Default               | Availability                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------- | ----------------------------------- |
| `SERVICE_ID`                                            | Service name in OpenTelemetry resource metadata                             | `fluxcd-notifications`| Config file or environment variable |
| `API_PORT`                                              | HTTP listen port                                                            | `8080`                | Config file or environment variable |
| `CONFIG_FILE`                                           | Path of the JSON configuration file                                         | `config.json`         | Environment variable only           |
| `OPENTELEMETRY_COLLECTOR_HTTP_TRACES`                   | OTEL collector endpoint for traces                                          | (empty)               | Config file or environment variable |
| `OPENTELEMETRY_COLLECTOR_HTTP_METRICS`                  | OTEL collector endpoint for metrics                                         | (empty)               | Config file or environment variable |
| `OPENTELEMETRY_COLLECTOR_HTTP_LOGS`                     | OTEL collector endpoint for logs                                            | (empty)               | Config file or environment variable |
| `OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS`  | Maximum delay before buffered logs are exported                             | `60`                  | Config file or environment variable |
| `OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS` | Interval used to export metrics                                           | `60`                  | Config file or environment variable |
| `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`            | Token sent to the collector as `Authorization: Bearer <value>` (sensitive)  | (empty)               | Environment variable only           |
| `WEBHOOK_AUTHORIZATION_HEADER`                          | Expected `Authorization` header on webhook events (sensitive)               | (empty)               | Environment variable only           |
| `WEBHOOK_AUTH_REQUIRED`                                 | Fail closed: refuse startup when the webhook header is empty                | `false`               | Config file or environment variable |
| `WEBHOOK_RATE_LIMIT_PER_MINUTE`                         | Per-client-IP rate limit on every route; `0` disables the limiter           | `600`                 | Config file or environment variable |
| `TRUST_PROXY`                                           | Client-IP model: empty/false (direct peer), `true`, or trusted proxy IPs/CIDRs | (empty)            | Config file or environment variable |
| `OPENTELEMETRY_CONSOLE_LOG_MODE`                        | Console mirroring: always, fallback (only without a collector) or never      | `always`              | Config file or environment variable |

`OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER` takes the token only; the adapter adds the `Bearer ` prefix.

The two authorization headers are secrets: provide them only as environment variables (in Kubernetes, from a Secret via `secretKeyRef`/`envFrom`), never in a ConfigMap or `config.json`.

Sensitive values are masked as `********************` in the configuration log output.

Fixed limits (not configurable):

- request body: 64 KiB (larger bodies are rejected with 413);
- message: 16 384 code points (16 KiB, up to ~64 KiB of UTF-16 data; truncated, with `flux.message.truncated=true`);
- every other input-derived string attribute: 256 code points (truncated, with `flux.attributes.truncated=true`);
- metric label values: 64 characters;
- truncation counts code points, so it never splits a surrogate pair;
- HTTP connection timeout 10 s, request timeout 15 s, keep-alive timeout 72 s;
- graceful shutdown flush bound: 10 s;
- rate-limit window: 60 s, at most 10 000 tracked clients, fixed-window (up to 2× the limit across a boundary, no global cap);
- rejection log sampling: first event per method/route-template/status/reason per rolling 60 s window, at most 256 tracked keys;
- log queue: 2 048 records, batch of 512, export timeout 30 s (worst case ~150 MiB queued, ~300 MiB during an export). Malformed, oversized and unsupported bodies additionally produce one `otel-utils-fastify` client-error WARN per request.

## Securing the webhook endpoint

Authentication is **fail-open by default** (`WEBHOOK_AUTH_REQUIRED=false`): when `WEBHOOK_AUTHORIZATION_HEADER` is empty, any request is accepted. This backward-compatible default should **not** be used in production. The adapter logs a startup warning (`webhook authentication disabled: WEBHOOK_AUTHORIZATION_HEADER is not set and WEBHOOK_AUTH_REQUIRED is false (backward-compatible fail-open)`) so the disabled state is visible.

Set `WEBHOOK_AUTH_REQUIRED=true` to make the posture explicit and fail closed: the adapter then **refuses to start** when `WEBHOOK_AUTHORIZATION_HEADER` is not set, instead of silently running unauthenticated. In Kubernetes the failure surfaces even earlier: the pod stays in `CreateContainerConfigError` because the Deployment references the Secret with `secretKeyRef` (the shipped examples enable the switch).

Authentication is active whenever `WEBHOOK_AUTHORIZATION_HEADER` is set, regardless of `WEBHOOK_AUTH_REQUIRED`: `POST /` requires the exact same `Authorization` header (timing-safe comparison). A missing or wrong header gets `401` with `WWW-Authenticate: Bearer` and counts as `rejected_events_total{reason="unauthorized"}`. The check runs in the `onRequest` phase before body parsing, so an unauthenticated request with a malformed or oversized body still gets `401` rather than `400`/`413`.

The Flux generic `Provider` adds HTTP headers from the `headers` key of its `secretRef` Secret, so a shared secret is configured like this (placeholders only — create real Secrets with `kubectl create secret` or your secret manager and never commit them):

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: otel-adapter
  namespace: flux-system
spec:
  type: generic
  address: http://fluxcd-notifications-otel-adapter.fluxcd-notifications-otel-adapter.svc.cluster.local:8080/
  secretRef:
    name: otel-adapter-headers
---
apiVersion: v1
kind: Secret
metadata:
  name: otel-adapter-headers
  namespace: flux-system
stringData:
  headers: |
    Authorization: Bearer <shared-secret>
---
# The matching adapter Secret, referenced by the Deployment's secretKeyRef
# (see the deployment examples in docs/deployments/kubernetes/kubernetes).
apiVersion: v1
kind: Secret
metadata:
  name: fluxcd-notifications-otel-adapter-secret
  namespace: fluxcd-notifications-otel-adapter
stringData:
  WEBHOOK_AUTHORIZATION_HEADER: Bearer <shared-secret>
```

The two `Bearer <shared-secret>` values must be identical.

Rotating the secret: update the adapter Secret (and the Flux Provider Secret), then run `kubectl rollout restart deployment/fluxcd-notifications-otel-adapter` — configuration and Secret values are read once at startup, there is no live reload.

Recommended production posture:

- set `WEBHOOK_AUTH_REQUIRED=true`, keep the shared secret in a Secret (never in a ConfigMap or `config.json`) and rotate it periodically;
- terminate TLS at an HTTPS ingress and restrict access with network policies (see [NetworkPolicy](#networkpolicy)) — the adapter itself serves plain HTTP;
- keep the in-process rate limiter as one layer and also rate-limit at the ingress, because the in-process limiter has no global cap;
- changing the header, the rate limit, `WEBHOOK_AUTH_REQUIRED` or `TRUST_PROXY` requires a restart (`kubectl rollout restart`).

### Client IP model and ingress contract

`TRUST_PROXY` is passed to Fastify `trustProxy` and decides what `request.ip` (and therefore the rate-limit bucket key) means:

| `TRUST_PROXY`                              | `request.ip`                                               | Use when                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| empty / `false` / `no` / `off` / `0`       | the direct peer address                                    | default; clients connect directly (NetworkPolicy) or you rate-limit at the ingress instead         |
| `true` / `yes` / `on`                      | the left-most `X-Forwarded-For` value, client-controlled    | never in production unless a proxy sanitizes and appends `X-Forwarded-For` to every request        |
| `10.0.0.0/8, loopback` (IPs/CIDRs/keywords) | `X-Forwarded-For` only when the direct peer is trusted      | ingress pods reach the adapter from a known CIDR that also sanitizes/appends `X-Forwarded-For`     |

Named keywords `loopback`, `linklocal` and `uniquelocal`, plain IPs and CIDR ranges are accepted, comma-separated. An invalid value fails startup with a clear error instead of failing per request.

Behind an ingress every request can share the ingress pod IP when `TRUST_PROXY` is off, so one noisy client can exhaust the 600/min bucket and legitimate Flux webhooks are answered `429`. Choose one of:

- set `TRUST_PROXY` to the ingress pod CIDR **only** if the ingress sanitizes/appends `X-Forwarded-For` and the adapter pods are not directly reachable (otherwise clients spoof the header and bypass the limiter);
- disable the in-process limiter (`WEBHOOK_RATE_LIMIT_PER_MINUTE=0`) and rate-limit at the ingress;
- raise the limit to the expected aggregate traffic when neither is possible.

The limiter never keys on the authorization token: the token is shared by every Flux event, so one bucket would couple all clients.

### NetworkPolicy

The Kustomize base includes a [NetworkPolicy](docs/deployments/kubernetes/kubernetes/base/networkpolicy.yaml) that only allows ingress to port 8080 from pods labelled `app: notification-controller` in the namespace `flux-system` — the default Flux installation. Adjust the `namespaceSelector`/`podSelector` if Flux runs elsewhere.

- HTTP probes (`GET /api/status`) keep working: kubelet probe traffic to/from the pod's node is exempt from NetworkPolicy, and NetworkPolicy cannot restrict by HTTP path (that would require an L7 policy, out of scope here).
- To allow an ingress controller (or any other source), add an entry to `ingress.from` — for example an `ipBlock` with the ingress pod CIDR, or a namespace/pod selector matching the controller.
- The [NodePort overlay](docs/deployments/kubernetes/kubernetes-nodeport) is blocked by this policy by default: NodePort clients come from outside the cluster and no `flux-system` pod is on the path. Add an explicit allow rule (e.g. an `ipBlock` for the client range) if you need NodePort access.

## Operations

To verify the adapter is forwarding:

- `kubectl logs -n fluxcd-notifications-otel-adapter deploy/fluxcd-notifications-otel-adapter` — each accepted event prints a `[level] [fluxcd-notifications] …` line unless `OPENTELEMETRY_CONSOLE_LOG_MODE` is `fallback` with a collector configured or `never`;
- query otel-light for the service name `fluxcd-notifications`, e.g. `GET /api/analytics/logs?serviceName=fluxcd-notifications&keywords=<cluster>`;
- `GET /api/status` returns `{"started": true, "version": "0.13.0"}`.

Useful alerts:

- no log records for the service during a period when Flux reconciles;
- growth of `rejected_events_total{reason="unauthorized"}` (misconfigured secret) or other rejection reasons;
- sustained `429` responses (`rejected_events_total{reason="rate_limited"}`), which mean the limit or the ingress fan-in needs review.

When correlating with traces, select on the `trace.id`/`span.id` attributes; that is the convention otel-light uses for adapter logs. The attributes carry the request span IDs, which are only joinable to actual traces when `OPENTELEMETRY_COLLECTOR_HTTP_TRACES` is configured: with no traces endpoint, no spans are exported and the IDs cannot be joined to a trace.

## Startup and packaging

The adapter imports only the `common-utils` subpaths it needs: `ConfigBase` from `@devopsplaybook.io/common-utils/config` and `createOTelContext` from `@devopsplaybook.io/common-utils/otel`. The barrel entry point would also load the full database and authentication stack (better-sqlite3, pg, bcrypt, jsonwebtoken, axios) even though the adapter uses none of it; the subpaths avoid those modules at startup (measured on Node 26, median of 5/3 runs: `Config` + `OTelContext` 560 modules / ~223 ms with the barrel versus 328 modules / ~112 ms with the subpaths; a full `dist/App.js` import drops from 658 modules / ~257 ms to 473 modules / ~155 ms).

`npm ci` still needs native build tooling (`python3`, `perl`, `alpine-sdk`) because `common-utils` declares those DB modules as regular dependencies, so they are installed and compiled even though the subpath imports never load them. The runtime image therefore still contains better-sqlite3, bcrypt and pg; removing them requires a shared-library change (out of scope here).

The production image is `node:26-alpine`, contains only the compiled `dist/`, `node_modules` and `config.json` (about 137 packages), runs as the unprivileged `node` user (UID 1000) and works with a read-only root filesystem — only `/tmp` needs a writable volume.

## License

This project is released under the MIT license; see [LICENSE](LICENSE).
