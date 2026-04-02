# Deploying with Kubernetes.

In the [fluxcd-notifications-otel-adapter] directory, you will find an example of deployment using Yaml files (with Kustomize)

To launch the application in Kubernetes with the default configuration:

```bash
git clone https://github.com/DidierHoarau/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/kubernetes/fluxcd-notifications-otel-adapter
kubectl kustomize . | kubectl apply -f -
```

To launch the application with the service exposed as a NodePort (for local cluster access):

```bash
git clone https://github.com/DidierHoarau/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/kubernetes/fluxcd-notifications-otel-adapter-nodeports
kubectl kustomize . | kubectl apply -f -
```
