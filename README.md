## FluxCD Notifications OpenTelemetry Adapter

FluxCD Notifications OpenTelemetry Adapter is a lightweight server that receives FluxCD notification webhooks and forwards them as OpenTelemetry logs to a configured collector. It enables observability pipelines to capture GitOps reconciliation events (deployments, image updates, alerts) alongside application telemetry in a unified backend.

## Installation

This adapter is meant to be deployed alongside your FluxCD installation in Kubernetes.

**Notes:**

- Configure the OpenTelemetry collector endpoints via the ConfigMap or environment variables.
- Point the FluxCD `Receiver` or `Alert` webhook to `http://<service-host>:8080/`.

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
# serviceaccount + rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fluxcd-notifications-otel-adapter-role
  namespace: fluxcd-notifications-otel-adapter
---
kind: ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: fluxcd-notifications-otel-adapter-role
subjects:
  - kind: ServiceAccount
    name: fluxcd-notifications-otel-adapter-role
    namespace: fluxcd-notifications-otel-adapter
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
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
      serviceAccountName: fluxcd-notifications-otel-adapter-role
      containers:
        - image: devopsplaybookio/fluxcd-notifications-otel-adapter:latest
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
              mountPath: /opt/app/fluxcd-notifications-otel-adapter/config.json
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

## Configuration

Configuration can be provided via the `config.json` ConfigMap or environment variables.

| Parameter                                               | Description                                       | Default              | Availability                        |
| ------------------------------------------------------- | ------------------------------------------------- | -------------------- | ----------------------------------- |
| SERVICE_ID                                              | Identifier used in OpenTelemetry service metadata | fluxcd-notifications | Config file or environment variable |
| LOG_LEVEL                                               | Logging verbosity level                           | info                 | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_HTTP_TRACES                     | OTEL collector endpoint for traces                | (empty)              | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_HTTP_METRICS                    | OTEL collector endpoint for metrics               | (empty)              | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_HTTP_LOGS                       | OTEL collector endpoint for logs                  | (empty)              | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS    | Interval (in seconds) to export logs              | 60                   | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS | Interval (in seconds) to export metrics           | 60                   | Config file or environment variable |
| OPENTELEMETRY_COLLECTOR_AWS                             | Enable AWS-specific OTEL configuration            | false                | Config file or environment variable |
| OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER              | Authorization header for OTEL collection          | (empty)              | Config file or environment variable |
| CORS_POLICY_ORIGIN                                      | Allowed CORS origin for the API                   | (empty)              | Config file or environment variable |
