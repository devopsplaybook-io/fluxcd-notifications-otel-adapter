# Deploying with Docker Compose

In the [fluxcd-notifications-otel-adapter](fluxcd-notifications-otel-adapter) directory, you will find an example of deployment using Docker Compose. Adjust `config.json` to point to your OpenTelemetry collector before starting.

To launch the application in Docker with Docker Compose:

```bash
git clone https://github.com/devopsplaybook-io/fluxcd-notifications-otel-adapter
cd fluxcd-notifications-otel-adapter/docs/deployments/docker-compose/fluxcd-notifications-otel-adapter
docker compose up -d
```

The webhook is then available at `http://localhost:8080/`.

`config.json` is read once at startup: restart the container (`docker compose restart`) after editing it.
