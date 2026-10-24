## FluxCD Notifications OpenTelemetry Adapter

FluxCD Notifications OpenTelemetry Adapter is a lightweight server that receives FluxCD notification webhooks and forwards them as OpenTelemetry logs to a configured collector. It enables observability pipelines to capture GitOps reconciliation events (deployments, image updates, alerts) alongside application telemetry in a unified backend.

Every accepted event becomes one OpenTelemetry log record with:

- the Flux `severity` mapped to the OTel severity (`info` → INFO, `error` → ERROR, `warn`/`warning` → WARN, anything else → INFO),
- a human-readable body: `<cluster>: <reason> - <message>`,
- structured attributes for querying and grouping:

| Attribute                   | Description                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `flux.cluster`              | Cluster name taken from the event metadata (see `eventMetadata` below)         |
| `flux.reason`               | Event reason, e.g. `ReconciliationSucceeded`                                   |
| `flux.severity`             | Normalized Flux severity: `info`, `warn`, `error` or `unknown`                 |
| `flux.object.kind`          | `involvedObject.kind` of the affected resource, e.g. `Kustomization`           |
| `flux.object.name`          | `involvedObject.name` of the affected resource                                 |
| `flux.object.namespace`     | `involvedObject.namespace` of the affected resource                            |
| `flux.object.apiVersion`    | `involvedObject.apiVersion` of the affected resource                           |
| `flux.object.uid`           | `involvedObject.uid` of the affected resource                                  |
| `flux.revision`             | Artifact revision from the event metadata (`…/revision` keys), when present    |
| `flux.reporting_controller` | `reportingController` of the emitting Flux controller, when present            |

Events whose metadata carries no cluster name are still forwarded with `flux.cluster: unknown`; payloads that are not usable Flux events are rejected with HTTP 400, counted in the `fluxcd-notifications.rejected_events_total` metric and logged as warnings.

The adapter also exposes Prometheus-style counters through the OpenTelemetry metrics endpoint:

- `fluxcd-notifications.events_total{cluster, reason, severity}` — accepted events,
- `fluxcd-notifications.rejected_events_total{reason}` — rejected payloads (`invalid_payload`) or unauthorized requests (`unauthorized`).

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

The backend then receives a log record with severity `INFO`, body `my-cluster: ReconciliationSucceeded - Reconciliation finished in 1.2s` and the `flux.*` attributes listed above, so failed reconciliations (`severity: error`) show up as ERROR records filterable by cluster, object and reason.

## Installation

This adapter is meant to be deployed alongside your FluxCD installation in Kubernetes.

**Notes:**

- Configure the OpenTelemetry collector endpoints via the ConfigMap or environment variables.
- Point the FluxCD `Provider` webhook to `http://<service-host>:8080/`.

Apply the following Kubernetes manifests:

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
      "OPENTELEMETRY_COLLECTOR_HTTP_LOGS": "",
      "OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS": "60",
      "OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS": "60",
      "OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER": ""
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
  revisionHistoryLimit: 1
  selector:
    matchLabels:
      app: fluxcd-notifications-otel-adapter
  template:
    metadata:
      labels:
        app: fluxcd-notifications-otel-adapter
    spec:
      serviceAccountName: fluxcd-notifications-otel-adapter
      containers:
        - image: devopsplaybookio/fluxcd-notifications-otel-adapter:0.8.0
          name: fluxcd-notifications-otel-adapter
          resources:
            limits:
              memory: 500Mi
              cpu: "1"
            requests:
              memory: 20Mi
              cpu: 100m
          volumeMounts:
            - name: config-volume
              mountPath: /opt/app/config.json
              subPath: config.json
          imagePullPolicy: Always
          readinessProbe:
            httpGet:
              path: /api/status
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
      volumes:
        - name: config-volume
          configMap:
            name: fluxcd-notifications-otel-adapter-config
---
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: fluxcd-notifications-otel-adapter
  namespace: fluxcd-notifications-otel-adapter
spec:
  ports:
    - name: tcp
      port: 8080
      targetPort: 8080
  selector:
    app: fluxcd-notifications-otel-adapter
```

Ready-made Kustomize examples are provided in [docs/deployments/kubernetes](docs/deployments/kubernetes). A Docker Compose example is provided in [docs/deployments/docker-compose](docs/deployments/docker-compose).

## Configuration

Configuration can be provided via the `config.json` ConfigMap or environment variables.

| Parameter                                               | Description                                        | Default              | Availability                        |
| ------------------------------------------------------- | -------------------------------------------------- | -------------------- | ----------------------------------- |
| SERVICE_ID                                              | Identifier used in OpenTelemetry service metadata  | fluxcd-notifications | Config file or environment variable |
| LOG_LEVEL                                               | Logging verbosity level                            | info                 | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_HTTP_TRACES                     | OTEL collector endpoint for traces                 | (empty)              | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_HTTP_METRICS                    | OTEL collector endpoint for metrics                | (empty)              | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_HTTP_LOGS                       | OTEL collector endpoint for logs                   | (empty)              | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS    | Interval (in seconds) to export logs               | 60                   | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS | Interval (in seconds) to export metrics            | 60                   | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_AWS                             | Enable AWS-specific OTEL configuration             | false                | Config file or environment variable |
| OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER              | Authorization header for OTEL collection           | (empty)              | Config file or environment variable |
| WEBHOOK_AUTHORIZATION_HEADER                            | Expected `Authorization` header on webhook events  | (empty)              | Config file or environment variable |

`GET /api/status` reports `{"started": true, "version": "<version>"}` and is meant for probes.

## Securing the webhook endpoint

When `WEBHOOK_AUTHORIZATION_HEADER` is set, `POST /` requires the exact same `Authorization` header and answers `401` otherwise; requests without it are counted in `fluxcd-notifications.rejected_events_total{reason="unauthorized"}`. When the value is empty (default), the endpoint accepts any request.

The Flux generic `Provider` adds HTTP headers from the `headers` key of its `secretRef` Secret, so a shared secret is configured like this:

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
    Authorization: Bearer s3cr3t
```

with `WEBHOOK_AUTHORIZATION_HEADER: "Bearer s3cr3t"` in the adapter configuration.
