# Deploying with Docker Compose

In the [fluxcd-notifications-otel-adapter](fluxcd-notifications-otel-adapter) directory, you will find an example of deployment using Docker Compose. Adjust `config.json` to point to your OpenTelemetry collector before starting.

The example enables `WEBHOOK_AUTH_REQUIRED=true`, so the container refuses to start until the webhook authorization header is provided. Authorization headers are secrets: pass them as environment variables (exported in the shell or in a git-ignored `.env` file next to `docker-compose.yaml`), never in `config.json` or any committed file.

Create the secrets before launching:

```bash
export WEBHOOK_AUTHORIZATION_HEADER='Bearer <shared-secret>'
# Optional: token for the collector's Authorization header.
# export OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER='<collector-token>'
```

To launch the application in Docker with Docker Compose:

```bash
git clone https://github.com/devopsplaybook-io/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/docker-compose/fluxcd-notifications-otel-adapter
docker compose up -d
```

With the header exported, the webhook then accepts `POST http://localhost:8080/` requests carrying the matching `Authorization` header; calls without it are rejected with `401`.

`config.json` is read once at startup: restart the container (`docker compose restart`) after editing it. Rotating the webhook secret also requires a restart (`docker compose up -d` re-reads the environment).

Use the same secret in the Flux `Provider`: set the `headers` field of the Flux `Provider` spec to `Authorization: Bearer <shared-secret>` (store it in a Kubernetes Secret when Flux runs in a cluster).
