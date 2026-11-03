# Deploying with Kubernetes.

In the [kubernetes](kubernetes) directory, you will find an example of deployment using Yaml files (with Kustomize). The service is a `ClusterIP` Service by default and the image is pinned to `0.14.0`.

The authorization headers are secrets and must come from a Kubernetes Secret (`secretKeyRef` in the Deployment), never from the ConfigMap or `config.json`. The example enables `WEBHOOK_AUTH_REQUIRED=true`: if the Secret is missing or its `WEBHOOK_AUTHORIZATION_HEADER` key is empty, the pod refuses to start instead of running unauthenticated.

Create the Secret **before** applying the manifests (the Deployment stays in `CreateContainerConfigError` until the Secret exists):

```bash
git clone https://github.com/devopsplaybook-io/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/kubernetes/kubernetes
kubectl apply -f base/namespace.yaml
kubectl -n fluxcd-notifications-otel-adapter create secret generic \
  fluxcd-notifications-otel-adapter-secret \
  --from-literal=WEBHOOK_AUTHORIZATION_HEADER='Bearer <shared-secret>'
# Optional: token for the collector's Authorization header.
# kubectl -n fluxcd-notifications-otel-adapter patch secret fluxcd-notifications-otel-adapter-secret \
#   -p '{"stringData":{"OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER":"<collector-token>"}}'
kubectl kustomize . | kubectl apply -f -
```

The Secret key `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER` is optional: without it, collector authentication is disabled (empty header).

With the webhook secret set, the webhook accepts `POST /` requests carrying the matching `Authorization` header; calls without it are rejected with `401`. Use the same secret in the Flux `Provider`: set the `headers` field of the Flux `Provider` spec to `Authorization: Bearer <shared-secret>`.

To launch the application with the service exposed as a NodePort (for local cluster access), use the [kubernetes-nodeport](kubernetes-nodeport) overlay:

```bash
git clone https://github.com/devopsplaybook-io/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/kubernetes/kubernetes-nodeport
kubectl kustomize . | kubectl apply -f -
```

### NetworkPolicy

The base includes a [NetworkPolicy](kubernetes/base/networkpolicy.yaml) that only allows ingress to port 8080 from pods labelled `app: notification-controller` in the namespace `flux-system` (the default Flux installation; adjust the selectors if Flux runs elsewhere). Two things to know:

- HTTP probes (`/api/status`) keep working: kubelet probe traffic to/from the pod's node is exempt from NetworkPolicy, and NetworkPolicy cannot restrict by HTTP path anyway (that would require an L7 policy, out of scope here).
- The NodePort overlay is blocked by the policy by default: clients reach the NodePort from outside the cluster, so no `flux-system` pod is on the path. Add an explicit allow rule (for example an `ipBlock` entry in the `ingress.from` list) if you need NodePort access.

### Rotating the secret and restarting

Both the ConfigMap and the Secret are read once at startup. After rotating the Secret (or editing the ConfigMap), restart the Deployment with `kubectl rollout restart deployment/fluxcd-notifications-otel-adapter` so the new value is picked up.
