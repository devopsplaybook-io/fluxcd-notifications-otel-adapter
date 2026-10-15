import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTelRequestContext } from "@devopsplaybook.io/otel-utils-fastify";
import type { FastifyInstance } from "fastify";
import type { Config } from "./Config";
import { OTelLogger, OTelMeter } from "./OTelContext";

const FLUX_NOTIFICATIONS_MODULE = "fluxcd-notifications";

export interface FluxEventPayload {
  message?: string;
  reason?: string;
  severity?: string;
  involvedObject?: {
    apiVersion?: string;
    kind?: string;
    name?: string;
    namespace?: string;
    uid?: string;
  };
  metadata?: Record<string, unknown>;
  reportingController?: string;
  timestamp?: string;
}

function mapSeverity(severity: string | undefined): {
  fluxSeverity: string;
  severityNumber: SeverityNumber;
  severityText: string;
} {
  const normalized = severity?.trim().toLowerCase();
  switch (normalized) {
    case "error":
      return {
        fluxSeverity: normalized,
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
      };
    case "warn":
    case "warning":
      return {
        fluxSeverity: "warn",
        severityNumber: SeverityNumber.WARN,
        severityText: "WARN",
      };
    default:
      return {
        fluxSeverity: normalized || "unknown",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      };
  }
}

function payloadExcerpt(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return String(text ?? "undefined").slice(0, 200);
}

function setIfPresent(
  attributes: Record<string, string>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string" && value) {
    attributes[key] = value;
  }
}

function findRevision(metadata: Record<string, unknown> | undefined): string | undefined {
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (key.endsWith("/revision") && typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

export function registerRoutes(fastify: FastifyInstance, config: Config): void {
  const logger = OTelLogger().createModuleLogger(FLUX_NOTIFICATIONS_MODULE);
  const otelLogger = OTelLogger().getLogger();
  const eventsTotal = OTelMeter().createCounter("events_total");
  const rejectedEventsTotal = OTelMeter().createCounter("rejected_events_total");

  fastify.get("/api/status", async () => {
    return { started: true, version: config.VERSION };
  });

  fastify.post("/", async (request, reply) => {
    if (
      config.WEBHOOK_AUTHORIZATION_HEADER &&
      request.headers.authorization !== config.WEBHOOK_AUTHORIZATION_HEADER
    ) {
      rejectedEventsTotal.add(1, { reason: "unauthorized" });
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }

    const event = request.body as FluxEventPayload | null | undefined;
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.message !== "string" ||
      !event.message ||
      typeof event.reason !== "string" ||
      !event.reason
    ) {
      rejectedEventsTotal.add(1, { reason: "invalid_payload" });
      logger.warn(
        `Rejected malformed Flux notification payload: ${payloadExcerpt(request.body)}`,
      );
      reply.status(400).send({ error: "Bad Request" });
      return;
    }

    const cluster =
      typeof event.metadata?.cluster === "string" && event.metadata.cluster
        ? event.metadata.cluster
        : "unknown";
    const { fluxSeverity, severityNumber, severityText } = mapSeverity(
      event.severity,
    );
    const bodyText = `${cluster}: ${event.reason} - ${event.message}`;

    const attributes: Record<string, string> = {
      "flux.cluster": cluster,
      "flux.reason": event.reason,
      "flux.severity": fluxSeverity,
    };
    const involvedObject = event.involvedObject;
    if (involvedObject && typeof involvedObject === "object") {
      setIfPresent(attributes, "flux.object.kind", involvedObject.kind);
      setIfPresent(attributes, "flux.object.name", involvedObject.name);
      setIfPresent(attributes, "flux.object.namespace", involvedObject.namespace);
      setIfPresent(attributes, "flux.object.apiVersion", involvedObject.apiVersion);
      setIfPresent(attributes, "flux.object.uid", involvedObject.uid);
    }
    const revision = findRevision(event.metadata);
    if (revision) {
      attributes["flux.revision"] = revision;
    }
    setIfPresent(
      attributes,
      "flux.reporting_controller",
      event.reportingController,
    );

    if (otelLogger) {
      const timestamp = Date.parse(event.timestamp ?? "");
      otelLogger.emit({
        severityNumber,
        severityText,
        body: bodyText,
        attributes,
        context: OTelRequestContext(request),
        ...(Number.isNaN(timestamp) ? {} : { timestamp }),
      });
      console.log(`[info] [${FLUX_NOTIFICATIONS_MODULE}] ${bodyText}`);
    } else {
      // No OTel logger configured (collector endpoint unset): ModuleLogger
      // still prints the record to the console for pod logs.
      logger.info(bodyText);
    }

    eventsTotal.add(1, {
      cluster,
      reason: event.reason,
      severity: fluxSeverity,
    });
    reply.status(200).send({ status: "ok" });
  });
}
