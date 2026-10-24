# Deploying with Kubernetes.

In the [kubernetes](kubernetes) directory, you will find an example of deployment using Yaml files (with Kustomize). The service is a `ClusterIP` Service by default and the image is pinned to `0.9.0`.

To launch the application in Kubernetes with the default configuration:

```bash
git clone https://github.com/devopsplaybook-io/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/kubernetes/kubernetes
kubectl kustomize . | kubectl apply -f -
```

To launch the application with the service exposed as a NodePort (for local cluster access), use the [kubernetes-nodeport](kubernetes-nodeport) overlay:

```bash
git clone https://github.com/devopsplaybook-io/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/kubernetes/kubernetes-nodeport
kubectl kustomize . | kubectl apply -f -
```

The ConfigMap is read once at startup: after editing it, restart the Deployment with `kubectl rollout restart deployment/fluxcd-notifications-otel-adapter`.
