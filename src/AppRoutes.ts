import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  OTelRequestContext,
  OTelRequestSpan,
} from "@devopsplaybook.io/otel-utils-fastify";
import type { FastifyInstance } from "fastify";
import { inspect } from "node:util";
import type { Config } from "./Config";
import { OTelLogger, OTelMeter } from "./OTelContext";

const FLUX_NOTIFICATIONS_MODULE = "fluxcd-notifications";

export const MAX_MESSAGE_LENGTH = 16 * 1024;
export const MAX_REASON_LENGTH = 256;
export const MAX_CLUSTER_LENGTH = 256;

const MAX_EXCERPT_LENGTH = 200;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 60 * 60 * 1000;

// Known Flux controllers in priority order: when several of them contribute a
// revision, the first one in this list wins instead of the first key returned
// by Object.entries().
const REVISION_KEY_PRIORITY = [
  "kustomize.toolkit.fluxcd.io/revision",
  "helm.toolkit.fluxcd.io/revision",
  "source.toolkit.fluxcd.io/revision",
  "notification.toolkit.fluxcd.io/revision",
];

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type LogLevel = "info" | "warn" | "error";

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
  logLevel: LogLevel;
} {
  const normalized = severity?.trim().toLowerCase();
  switch (normalized) {
    case "error":
      return {
        fluxSeverity: normalized,
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
        logLevel: "error",
      };
    case "warn":
    case "warning":
      return {
        fluxSeverity: "warn",
        severityNumber: SeverityNumber.WARN,
        severityText: "WARN",
        logLevel: "warn",
      };
    default:
      return {
        fluxSeverity: normalized || "unknown",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        logLevel: "info",
      };
  }
}

// Console (and ModuleLogger fallback) rendering only: strip ANSI escape
// sequences and control characters so an event cannot forge log lines. The
// OTel record body and flux.* attributes keep the raw values on purpose.
function sanitizeForConsole(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "") // OSC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, "") // CSI sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-_]/g, "") // other two-character escapes
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function payloadExcerpt(body: unknown): string {
  if (typeof body === "string") {
    return body.slice(0, MAX_EXCERPT_LENGTH);
  }
  // Bound the inspection so a large payload is never fully stringified.
  return inspect(body, {
    depth: 1,
    maxArrayLength: 10,
    maxStringLength: MAX_EXCERPT_LENGTH,
    breakLength: Infinity,
  }).slice(0, MAX_EXCERPT_LENGTH);
}

function setIfPresent(
  attributes: Record<string, string | boolean>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string" && value) {
    attributes[key] = value;
  }
}

function findRevision(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const revisions = new Map<string, string>();
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (key.endsWith("/revision") && typeof value === "string" && value) {
      revisions.set(key, value);
    }
  }
  for (const key of REVISION_KEY_PRIORITY) {
    const value = revisions.get(key);
    if (value) {
      return value;
    }
  }
  const [firstRemaining] = [...revisions.keys()].sort();
  return firstRemaining ? revisions.get(firstRemaining) : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function resolveTimestamp(value: unknown): number {
  const now = Date.now();
  if (typeof value !== "string" || !RFC3339_RE.test(value)) {
    return now;
  }
  const parsed = Date.parse(value);
  if (
    Number.isNaN(parsed) ||
    parsed < MIN_TIMESTAMP_MS ||
    parsed > now + MAX_FUTURE_MS
  ) {
    return now;
  }
  return parsed;
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
    const message =
      event && typeof event === "object" && typeof event.message === "string"
        ? event.message.trim()
        : "";
    if (!event || typeof event !== "object" || !message) {
      rejectedEventsTotal.add(1, { reason: "invalid_payload" });
      logger.warn(
        `Rejected malformed Flux notification payload: ${payloadExcerpt(request.body)}`,
      );
      reply.status(400).send({ error: "Bad Request" });
      return;
    }

    const rawReason =
      typeof event.reason === "string" ? event.reason.trim() : "";
    const reason = truncate(rawReason || "unknown", MAX_REASON_LENGTH);
    const rawCluster =
      typeof event.metadata?.cluster === "string"
        ? event.metadata.cluster.trim()
        : "";
    const cluster = truncate(rawCluster || "unknown", MAX_CLUSTER_LENGTH);
    const messageTruncated = message.length > MAX_MESSAGE_LENGTH;
    const emittedMessage = truncate(message, MAX_MESSAGE_LENGTH);
    const { fluxSeverity, severityNumber, severityText, logLevel } =
      mapSeverity(event.severity);
    const bodyText = `${cluster}: ${reason} - ${emittedMessage}`;

    const attributes: Record<string, string | boolean> = {
      "flux.cluster": cluster,
      "flux.reason": reason,
      "flux.severity": fluxSeverity,
    };
    if (messageTruncated) {
      attributes["flux.message.truncated"] = true;
    }
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
      // otel-light correlates logs from the trace.id/span.id attributes only,
      // not from the OTLP traceId/spanId fields of the record.
      const spanContext = OTelRequestSpan(request)?.spanContext();
      if (spanContext?.traceId && spanContext?.spanId) {
        attributes["trace.id"] = spanContext.traceId;
        attributes["span.id"] = spanContext.spanId;
      }
      otelLogger.emit({
        severityNumber,
        severityText,
        body: bodyText,
        attributes,
        context: OTelRequestContext(request),
        timestamp: resolveTimestamp(event.timestamp),
      });
      console.log(
        `[${logLevel}] [${FLUX_NOTIFICATIONS_MODULE}] ${sanitizeForConsole(bodyText)}`,
      );
    } else {
      // No OTel logger configured (collector endpoint unset): ModuleLogger
      // still prints the record to the console for pod logs.
      const fallbackBody = sanitizeForConsole(bodyText);
      if (logLevel === "error") {
        logger.error(fallbackBody);
      } else if (logLevel === "warn") {
        logger.warn(fallbackBody);
      } else {
        logger.info(fallbackBody);
      }
    }

    eventsTotal.add(1, {
      cluster,
      reason,
      severity: fluxSeverity,
    });
    reply.status(200).send({ status: "ok" });
  });
}
