import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  OTelRequestContext,
  OTelRequestSpan,
} from "@devopsplaybook.io/otel-utils-fastify";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Config } from "./Config";
import { OTelLogger, OTelMeter } from "./OTelContext";
import { RateLimiter, resolveRateLimitPerMinute } from "./RateLimiter";
import { RejectionLogSampler } from "./RejectionLogSampler";

const FLUX_NOTIFICATIONS_MODULE = "fluxcd-notifications";

export const MAX_MESSAGE_LENGTH = 16 * 1024;
// Every input-derived string attribute is bounded to this many code points.
export const MAX_ATTRIBUTE_LENGTH = 256;
export const MAX_REASON_LENGTH = MAX_ATTRIBUTE_LENGTH;
export const MAX_CLUSTER_LENGTH = MAX_ATTRIBUTE_LENGTH;
export const MAX_METRIC_ATTRIBUTE_LENGTH = 64;

const MAX_EXCERPT_LENGTH = 200;
const MAX_ROUTE_LENGTH = 120;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 60 * 60 * 1000;

export type RejectionReason =
  | "invalid_json"
  | "payload_too_large"
  | "unsupported_media_type"
  | "bad_request"
  | "unauthorized"
  | "rate_limited"
  | "invalid_payload";

export type MetricSeverity = "info" | "warn" | "error" | "unknown";

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

function mapSeverity(severity: unknown): {
  fluxSeverity: string;
  metricSeverity: MetricSeverity;
  severityNumber: SeverityNumber;
  severityText: string;
  logLevel: LogLevel;
} {
  const normalized =
    typeof severity === "string" ? severity.trim().toLowerCase() : "";
  switch (normalized) {
    case "error":
      return {
        fluxSeverity: normalized,
        metricSeverity: "error",
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
        logLevel: "error",
      };
    case "warn":
    case "warning":
      return {
        fluxSeverity: "warn",
        metricSeverity: "warn",
        severityNumber: SeverityNumber.WARN,
        severityText: "WARN",
        logLevel: "warn",
      };
    default:
      return {
        fluxSeverity: normalized || "unknown",
        metricSeverity: normalized === "info" ? "info" : "unknown",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        logLevel: "info",
      };
  }
}

// Console (and ModuleLogger fallback) rendering only: strip ANSI escape
// sequences and control characters so an event cannot forge log lines. The
// OTel record body and flux.* attributes keep the raw values on purpose.
// A single left-to-right scan keeps this linear even for adversarial input
// such as many repeated OSC starts without a terminator.
export function sanitizeForConsole(value: string): string {
  let out = "";
  let runStart = 0;
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === 0x1b) {
      const next = value.charCodeAt(i + 1);
      if (next === 0x5d) {
        // OSC: ESC ] ... BEL or ESC \. Without a terminator the remainder is
        // dropped so the scan never revisits the same input.
        out += value.slice(runStart, i);
        let j = i + 2;
        while (j < value.length) {
          const c = value.charCodeAt(j);
          if (c === 0x07) {
            j += 1;
            break;
          }
          if (c === 0x1b && value.charCodeAt(j + 1) === 0x5c) {
            j += 2;
            break;
          }
          j += 1;
        }
        i = j;
        runStart = i;
        continue;
      }
      if (next === 0x5b) {
        // CSI: ESC [ params intermediates final
        let j = i + 2;
        while (j < value.length) {
          const c = value.charCodeAt(j);
          if (
            (c >= 0x30 && c <= 0x39) ||
            c === 0x3a ||
            c === 0x3b ||
            c === 0x3f
          ) {
            j++;
          } else {
            break;
          }
        }
        while (
          j < value.length &&
          value.charCodeAt(j) >= 0x20 &&
          value.charCodeAt(j) <= 0x2f
        ) {
          j++;
        }
        const final = j < value.length ? value.charCodeAt(j) : 0;
        out += value.slice(runStart, i);
        if (final >= 0x40 && final <= 0x7e) {
          i = j + 1;
        } else {
          // Incomplete CSI: drop ESC [ only, keep scanning the payload.
          i += 2;
        }
        runStart = i;
        continue;
      }
      if (next >= 0x40 && next <= 0x5f) {
        // Other two-character escape (e.g. ESC M).
        out += value.slice(runStart, i);
        i += 2;
        runStart = i;
        continue;
      }
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      out += value.slice(runStart, i) + " ";
      i += 1;
      runStart = i;
      continue;
    }
    i += 1;
  }
  return out + value.slice(runStart);
}

// Rejected bodies can contain credentials: describe the structure and types
// only, never key names, excerpts or values.
export function describeRequestBody(body: unknown): string {
  if (body === null) {
    return "body_type=null";
  }
  if (body === undefined) {
    return "body_type=undefined";
  }
  if (Array.isArray(body)) {
    return `body_type=array item_count=${body.length}`;
  }
  if (typeof body !== "object") {
    return `body_type=${typeof body}`;
  }
  const keys = Object.keys(body);
  const hasMessage = Object.prototype.hasOwnProperty.call(body, "message");
  const messageType = hasMessage
    ? typeof (body as Record<string, unknown>).message
    : undefined;
  return hasMessage
    ? `body_type=object key_count=${keys.length} has_message=true message_type=${messageType}`
    : `body_type=object key_count=${keys.length} has_message=false`;
}

function boundAttribute(value: string, onTruncated: () => void): string {
  const bounded = truncate(value, MAX_ATTRIBUTE_LENGTH);
  if (bounded !== value) {
    onTruncated();
  }
  return bounded;
}

function setIfPresent(
  attributes: Record<string, string | boolean>,
  key: string,
  value: unknown,
  onTruncated: () => void,
): void {
  if (typeof value === "string" && value) {
    attributes[key] = boundAttribute(value, onTruncated);
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

// Counts Unicode code points so truncation never splits a surrogate pair.
export function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value; // code points <= code units
  let codePoints = 0;
  let index = 0;
  for (const char of value) {
    if (codePoints === maxLength) break;
    codePoints += 1;
    index += char.length;
  }
  return index >= value.length ? value : value.slice(0, index);
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

// Metric labels are normalized to a bounded, low-cardinality set; the raw
// values stay in the log record and body.
export function normalizeMetricReason(raw: string): string {
  const normalized = truncate(
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, "_")
      .replace(/^_+|_+$/g, ""),
    MAX_METRIC_ATTRIBUTE_LENGTH,
  );
  return normalized || "unknown";
}

export function normalizeMetricCluster(raw: string): string {
  const normalized = truncate(
    raw
      .trim()
      .replace(/[^A-Za-z0-9_.:-]+/g, "_")
      .replace(/^_+|_+$/g, ""),
    MAX_METRIC_ATTRIBUTE_LENGTH,
  );
  return normalized || "unknown";
}

export function isAuthorized(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || !expected) {
    return false;
  }
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function mapErrorRejectionReason(
  error: FastifyError,
  statusCode: number,
): RejectionReason {
  if (statusCode === 413) {
    return "payload_too_large";
  }
  if (statusCode === 415) {
    return "unsupported_media_type";
  }
  if (
    statusCode === 400 &&
    error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
  ) {
    return "invalid_json";
  }
  return "bad_request";
}

function sendError(
  reply: FastifyReply,
  error: FastifyError,
  statusCode: number,
): void {
  const { headers } = error as FastifyError & {
    headers?: Record<string, string>;
  };
  if (headers) {
    reply.headers(headers);
  }
  if (statusCode >= 500) {
    // Never leak internal error messages; details stay in the server logs.
    reply.status(statusCode).send({ statusCode, error: "Internal Server Error" });
    return;
  }
  reply.status(statusCode).send(error);
}

const STANDARD_HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);

function normalizedMethod(method: string): string {
  const upper = method.toUpperCase();
  return STANDARD_HTTP_METHODS.has(upper) ? upper : "OTHER";
}

export function registerRoutes(fastify: FastifyInstance, config: Config): void {
  const logger = OTelLogger().createModuleLogger(FLUX_NOTIFICATIONS_MODULE);
  const otelLogger = OTelLogger().getLogger();
  const consoleLogMode = config.OPENTELEMETRY_CONSOLE_LOG_MODE;
  const eventsTotal = OTelMeter().createCounter("events_total");
  const rejectedEventsTotal = OTelMeter().createCounter("rejected_events_total");

  // Tracks requests already accounted for by the handler or a dedicated hook,
  // so the error handler never counts the same rejection twice.
  const rejectedRequests = new WeakSet<object>();

  // One sampler per server instance; metrics stay exact, only the log line is
  // sampled (first event per method/route/status/reason per 60 s window).
  const rejectionLogSampler = new RejectionLogSampler();

  const requestRoute = (request: FastifyRequest): string => {
    const path = request.url.split("?")[0];
    return `${request.method} ${truncate(sanitizeForConsole(path), MAX_ROUTE_LENGTH)}`;
  };

  // The route template (never the raw path) keeps the sampling-key space small;
  // unknown routes use a fixed placeholder because routeOptions.url is absent.
  const rejectionSamplingKey = (
    request: FastifyRequest,
    status: number,
    reason: RejectionReason,
  ): string =>
    `${normalizedMethod(request.method)} ${request.routeOptions?.url ?? "unmatched"} ${status} ${reason}`;

  const recordRejection = (
    request: FastifyRequest,
    status: number,
    reason: RejectionReason,
    detail?: string,
    level: "info" | "warn" = "warn",
  ): void => {
    rejectedRequests.add(request);
    rejectedEventsTotal.add(1, { reason });
    const decision = rejectionLogSampler.check(
      rejectionSamplingKey(request, status, reason),
    );
    if (!decision.log) {
      return;
    }
    const suppressed =
      decision.suppressed > 0 ? ` suppressed=${decision.suppressed}` : "";
    const message = `Webhook request rejected: route=${requestRoute(request)} status=${status} reason=${reason}${suppressed}`;
    const line = detail ? `${message} ${detail}` : message;
    if (level === "info") {
      logger.info(line);
    } else {
      logger.warn(line);
    }
  };

  const rateLimiter = new RateLimiter({
    limitPerMinute: resolveRateLimitPerMinute(
      config.WEBHOOK_RATE_LIMIT_PER_MINUTE,
    ),
  });

  // Key on the client IP only. Never key on the authorization token: it is
  // shared by every Flux event, so one token would mean one global bucket.
  const clientKey = (request: FastifyRequest): string => {
    const ip = request.ip;
    if (isIP(ip) !== 0) {
      return ip;
    }
    // With trustProxy, a malformed X-Forwarded-For value makes request.ip an
    // arbitrary string; fall back to the validated socket address so the
    // limiter map keeps a bounded, non-spoofable key space.
    const remoteAddress = request.socket.remoteAddress;
    if (typeof remoteAddress === "string" && isIP(remoteAddress) !== 0) {
      return remoteAddress;
    }
    return "unknown";
  };

  // onRequest runs before body parsing, so an over-limit body is never read.
  const rateLimitHook = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const decision = rateLimiter.allow(clientKey(request));
    if (decision.allowed) {
      return;
    }
    recordRejection(
      request,
      429,
      "rate_limited",
      `retry_after=${decision.retryAfterSeconds}s`,
    );
    reply.header("Retry-After", String(decision.retryAfterSeconds));
    await reply.status(429).send({ error: "Too Many Requests" });
  };

  // Root-level hooks also run for unmatched routes, so the limiter covers
  // /api/status, 404s and every future route. It is registered before the
  // routes so it also runs before the route-level authentication hook (429
  // wins over 401).
  fastify.addHook("onRequest", rateLimitHook);

  // onRequest runs before body parsing, so an unauthenticated body is never
  // read. Rate limiting is registered first and therefore still wins (429).
  const authHook = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!config.WEBHOOK_AUTHORIZATION_HEADER) {
      return;
    }
    if (
      isAuthorized(
        request.headers.authorization,
        config.WEBHOOK_AUTHORIZATION_HEADER,
      )
    ) {
      return;
    }
    recordRejection(request, 401, "unauthorized");
    reply.header("WWW-Authenticate", "Bearer");
    await reply.status(401).send({ error: "Unauthorized" });
  };

  fastify.get("/api/status", async () => {
    return { started: true, version: config.VERSION };
  });

  fastify.post(
    "/",
    { onRequest: [authHook] },
    async (request, reply) => {
      let attributesTruncated = false;
      const markAttributeTruncated = (): void => {
        attributesTruncated = true;
      };

      const event = request.body as FluxEventPayload | null | undefined;
      const message =
        event && typeof event === "object" && typeof event.message === "string"
          ? event.message.trim()
          : "";
      if (!event || typeof event !== "object" || !message) {
        recordRejection(
          request,
          400,
          "invalid_payload",
          describeRequestBody(request.body),
        );
        reply.status(400).send({ error: "Bad Request" });
        return;
      }

      const rawReason =
        typeof event.reason === "string" ? event.reason.trim() : "";
      const reason = boundAttribute(
        rawReason || "unknown",
        markAttributeTruncated,
      );
      const rawCluster =
        typeof event.metadata?.cluster === "string"
          ? event.metadata.cluster.trim()
          : "";
      const cluster = boundAttribute(
        rawCluster || "unknown",
        markAttributeTruncated,
      );
      const emittedMessage = truncate(message, MAX_MESSAGE_LENGTH);
      const messageTruncated = emittedMessage !== message;
      const {
        fluxSeverity,
        metricSeverity,
        severityNumber,
        severityText,
        logLevel,
      } = mapSeverity(event.severity);
      const bodyText = `${cluster}: ${reason} - ${emittedMessage}`;

      const attributes: Record<string, string | boolean> = {
        "flux.cluster": cluster,
        "flux.reason": reason,
        "flux.severity": boundAttribute(fluxSeverity, markAttributeTruncated),
      };
      if (messageTruncated) {
        attributes["flux.message.truncated"] = true;
      }
      const involvedObject = event.involvedObject;
      if (involvedObject && typeof involvedObject === "object") {
        setIfPresent(
          attributes,
          "flux.object.kind",
          involvedObject.kind,
          markAttributeTruncated,
        );
        setIfPresent(
          attributes,
          "flux.object.name",
          involvedObject.name,
          markAttributeTruncated,
        );
        setIfPresent(
          attributes,
          "flux.object.namespace",
          involvedObject.namespace,
          markAttributeTruncated,
        );
        setIfPresent(
          attributes,
          "flux.object.apiVersion",
          involvedObject.apiVersion,
          markAttributeTruncated,
        );
        setIfPresent(
          attributes,
          "flux.object.uid",
          involvedObject.uid,
          markAttributeTruncated,
        );
      }
      const revision = findRevision(event.metadata);
      if (revision) {
        attributes["flux.revision"] = boundAttribute(
          revision,
          markAttributeTruncated,
        );
      }
      setIfPresent(
        attributes,
        "flux.reporting_controller",
        event.reportingController,
        markAttributeTruncated,
      );
      if (attributesTruncated) {
        attributes["flux.attributes.truncated"] = true;
      }

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
        // The structured record is already emitted above; mirror it to the
        // console in the module-logger format unless the mode suppresses the
        // mirror while a collector exists ("fallback") or unconditionally
        // ("never"). An invalid value follows otel-utils' "always" default.
        if (consoleLogMode !== "never" && consoleLogMode !== "fallback") {
          const line = `[${logLevel}] [${FLUX_NOTIFICATIONS_MODULE}] ${sanitizeForConsole(bodyText)}`;
          if (logLevel === "error") {
            console.error(line);
          } else if (logLevel === "warn") {
            console.warn(line);
          } else {
            console.log(line);
          }
        }
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
        cluster: normalizeMetricCluster(cluster),
        reason: normalizeMetricReason(reason),
        severity: metricSeverity,
      });
      reply.status(200).send({ status: "ok" });
    },
  );

  fastify.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (rejectedRequests.has(request)) {
      sendError(reply, error, statusCode);
      return;
    }
    if (statusCode >= 500) {
      logger.error(
        `Webhook request failed: route=${requestRoute(request)} status=${statusCode} code=${truncate(sanitizeForConsole(String(error.code ?? "unknown")), MAX_EXCERPT_LENGTH)} message=${truncate(sanitizeForConsole(error.message), MAX_EXCERPT_LENGTH)}`,
      );
      sendError(reply, error, statusCode);
      return;
    }
    recordRejection(
      request,
      statusCode,
      mapErrorRejectionReason(error, statusCode),
      `message=${truncate(sanitizeForConsole(error.message), MAX_EXCERPT_LENGTH)}`,
    );
    sendError(reply, error, statusCode);
  });

  fastify.setNotFoundHandler((request, reply) => {
    // Unknown routes are noise while being scanned: log the sampled first
    // occurrence at INFO and keep the exact count in rejected_events_total.
    recordRejection(request, 404, "bad_request", undefined, "info");
    reply.status(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });
}
