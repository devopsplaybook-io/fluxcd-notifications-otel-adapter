// Mock AppRoutes dependencies before any imports
const mockModuleLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockRawEmit = jest.fn();
const mockGetLogger = jest.fn().mockReturnValue({ emit: mockRawEmit });
const mockEventsCounter = { add: jest.fn() };
const mockRejectedEventsCounter = { add: jest.fn() };
const mockRequestContext = { traceId: "test-trace-id" };
const mockRequestSpan = jest.fn();

jest.mock("./OTelContext", () => ({
  OTelLogger: jest.fn(() => ({
    createModuleLogger: jest.fn().mockReturnValue(mockModuleLogger),
    getLogger: mockGetLogger,
  })),
  OTelMeter: jest.fn(() => ({
    createCounter: jest.fn().mockImplementation((key: string) =>
      key === "events_total" ? mockEventsCounter : mockRejectedEventsCounter,
    ),
  })),
}));

jest.mock("@devopsplaybook.io/otel-utils-fastify", () => ({
  OTelRequestContext: jest.fn().mockReturnValue(mockRequestContext),
  OTelRequestSpan: mockRequestSpan,
}));

jest.mock("./Config", () => ({ Config: jest.fn() }));

// swc hoists static imports above the mock declarations, so load the module
// under test with an in-place require after jest.mock registration.
const { registerRoutes } = require("./AppRoutes");
const { FASTIFY_OPTIONS } = require("./App");

import Fastify from "fastify";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { FluxEventPayload } from "./AppRoutes";
import type { Config } from "./Config";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    VERSION: "1.2.3",
    WEBHOOK_AUTHORIZATION_HEADER: "",
    WEBHOOK_RATE_LIMIT_PER_MINUTE: 600,
    ...overrides,
  } as unknown as Config;
}

function fullFluxPayload(): FluxEventPayload {
  return {
    severity: "info",
    timestamp: "2026-10-15T10:00:00Z",
    message: "Deployment my-app applied successfully",
    reason: "ReconciliationSucceeded",
    involvedObject: {
      apiVersion: "kustomize.toolkit.fluxcd.io/v1",
      kind: "Kustomization",
      name: "apps",
      namespace: "flux-system",
      uid: "3f9a2b1c-0000-0000-0000-000000000001",
    },
    reportingController: "kustomize-controller",
    metadata: {
      cluster: "production-us-east-1",
      "kustomize.toolkit.fluxcd.io/revision": "main@sha1:0123456789abcdef",
    },
  };
}

describe("App API routes", () => {
  let fastify: ReturnType<typeof Fastify>;
  let config: Config;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    config = buildConfig();
    fastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
    registerRoutes(fastify, config);
  });

  afterEach(async () => {
    await fastify.close();
    jest.restoreAllMocks();
  });

  async function postEvent(payload: unknown) {
    return fastify.inject({
      method: "POST",
      url: "/",
      payload: payload as Record<string, unknown>,
    });
  }

  describe("GET /api/status", () => {
    it("should return started true and the configured version", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/status",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ started: true, version: "1.2.3" });
    });
  });

  describe("POST /", () => {
    it("should forward a complete flux notification as a raw OTel log record", async () => {
      const response = await postEvent(fullFluxPayload());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
      expect(mockRawEmit).toHaveBeenCalledTimes(1);
      const record = mockRawEmit.mock.calls[0][0];
      expect(record.severityNumber).toBe(SeverityNumber.INFO);
      expect(record.severityText).toBe("INFO");
      expect(record.body).toBe(
        "production-us-east-1: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
      expect(record.attributes).toEqual({
        "flux.cluster": "production-us-east-1",
        "flux.reason": "ReconciliationSucceeded",
        "flux.severity": "info",
        "flux.object.kind": "Kustomization",
        "flux.object.name": "apps",
        "flux.object.namespace": "flux-system",
        "flux.object.apiVersion": "kustomize.toolkit.fluxcd.io/v1",
        "flux.object.uid": "3f9a2b1c-0000-0000-0000-000000000001",
        "flux.revision": "main@sha1:0123456789abcdef",
        "flux.reporting_controller": "kustomize-controller",
      });
      expect(record.context).toBe(mockRequestContext);
      expect(record.timestamp).toBe(Date.parse("2026-10-15T10:00:00Z"));
    });

    it("should count the forwarded event by cluster, reason and severity", async () => {
      await postEvent(fullFluxPayload());

      expect(mockEventsCounter.add).toHaveBeenCalledWith(1, {
        cluster: "production-us-east-1",
        reason: "reconciliationsucceeded",
        severity: "info",
      });
      expect(mockRejectedEventsCounter.add).not.toHaveBeenCalled();
    });

    it("should log the event to the console in the module logger format", async () => {
      await postEvent(fullFluxPayload());

      expect(console.log).toHaveBeenCalledWith(
        "[info] [fluxcd-notifications] production-us-east-1: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
    });

    it("should fall back to module logger only when no OTel logger is available", async () => {
      mockGetLogger.mockReturnValueOnce(undefined);
      const fallbackFastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
      registerRoutes(fallbackFastify, config);

      await fallbackFastify.inject({
        method: "POST",
        url: "/",
        payload: fullFluxPayload(),
      });
      await fallbackFastify.close();

      expect(mockRawEmit).not.toHaveBeenCalled();
      expect(mockModuleLogger.info).toHaveBeenCalledWith(
        "production-us-east-1: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
    });

    it("should render an error event as error on the console", async () => {
      const payload = fullFluxPayload();
      payload.severity = "error";

      await postEvent(payload);

      expect(console.log).toHaveBeenCalledWith(
        "[error] [fluxcd-notifications] production-us-east-1: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
    });

    it("should use logger.error on the fallback path for an error event", async () => {
      mockGetLogger.mockReturnValueOnce(undefined);
      const payload = fullFluxPayload();
      payload.severity = "error";
      const fallbackFastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
      registerRoutes(fallbackFastify, config);

      await fallbackFastify.inject({
        method: "POST",
        url: "/",
        payload,
      });
      await fallbackFastify.close();

      expect(mockModuleLogger.error).toHaveBeenCalledWith(
        "production-us-east-1: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
      expect(mockModuleLogger.info).not.toHaveBeenCalled();
    });

    it("should render a warning event as warn on the console", async () => {
      const payload = fullFluxPayload();
      payload.severity = "warning";

      await postEvent(payload);

      expect(console.log).toHaveBeenCalledWith(
        "[warn] [fluxcd-notifications] production-us-east-1: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
    });

    it("should use logger.warn on the fallback path for a warning event", async () => {
      mockGetLogger.mockReturnValueOnce(undefined);
      const payload = fullFluxPayload();
      payload.severity = "warning";
      const fallbackFastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
      registerRoutes(fallbackFastify, config);

      await fallbackFastify.inject({
        method: "POST",
        url: "/",
        payload,
      });
      await fallbackFastify.close();

      expect(mockModuleLogger.warn).toHaveBeenCalledWith(
        "production-us-east-1: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
    });

    it("should strip control characters and ANSI escapes from the console but keep the raw record", async () => {
      const payload = {
        message: "line1\nline2 \u001b[31mred\u001b[0m",
        reason: "ReconciliationSucceeded",
      };

      await postEvent(payload);

      const consoleLine = (console.log as jest.Mock).mock.calls[0][0] as string;
      expect(consoleLine).not.toContain("\n");
      expect(consoleLine).not.toContain("\u001b");
      expect(consoleLine).toBe(
        "[info] [fluxcd-notifications] unknown: ReconciliationSucceeded - line1 line2 red",
      );

      const record = mockRawEmit.mock.calls[0][0];
      expect(record.body).toBe(
        "unknown: ReconciliationSucceeded - line1\nline2 \u001b[31mred\u001b[0m",
      );
    });

    it("should sanitize the fallback logger rendering as well", async () => {
      mockGetLogger.mockReturnValueOnce(undefined);
      const fallbackFastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
      registerRoutes(fallbackFastify, config);

      await fallbackFastify.inject({
        method: "POST",
        url: "/",
        payload: {
          message: "first\nsecond",
          reason: "ReconciliationSucceeded",
        },
      });
      await fallbackFastify.close();

      const rendered = mockModuleLogger.info.mock.calls[0][0] as string;
      expect(rendered).not.toContain("\n");
      expect(rendered).toContain("first second");
    });

    it("should map error severity to OTel ERROR", async () => {
      const payload = fullFluxPayload();
      payload.severity = "error";

      await postEvent(payload);

      const record = mockRawEmit.mock.calls[0][0];
      expect(record.severityNumber).toBe(SeverityNumber.ERROR);
      expect(record.severityText).toBe("ERROR");
      expect(record.attributes["flux.severity"]).toBe("error");
    });

    it("should map warning severity to OTel WARN", async () => {
      const payload = fullFluxPayload();
      payload.severity = "warning";

      await postEvent(payload);

      const record = mockRawEmit.mock.calls[0][0];
      expect(record.severityNumber).toBe(SeverityNumber.WARN);
      expect(record.severityText).toBe("WARN");
      expect(record.attributes["flux.severity"]).toBe("warn");
    });

    it("should map an unknown severity to OTel INFO but keep the raw value as attribute", async () => {
      const payload = fullFluxPayload();
      payload.severity = "critical";

      await postEvent(payload);

      const record = mockRawEmit.mock.calls[0][0];
      expect(record.severityNumber).toBe(SeverityNumber.INFO);
      expect(record.severityText).toBe("INFO");
      expect(record.attributes["flux.severity"]).toBe("critical");
    });

    it("should default missing cluster to unknown instead of rejecting the event", async () => {
      const payload = fullFluxPayload();
      delete payload.metadata;

      const response = await postEvent(payload);

      expect(response.statusCode).toBe(200);
      const record = mockRawEmit.mock.calls[0][0];
      expect(record.attributes["flux.cluster"]).toBe("unknown");
      expect(record.body).toBe(
        "unknown: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
    });

    it("should omit optional attributes when not provided", async () => {
      const payload = {
        message: "Deployment applied",
        reason: "ReconciliationSucceeded",
      };

      const before = Date.now();
      const response = await postEvent(payload);
      const after = Date.now();

      expect(response.statusCode).toBe(200);
      const record = mockRawEmit.mock.calls[0][0];
      expect(record.attributes).toEqual({
        "flux.cluster": "unknown",
        "flux.reason": "ReconciliationSucceeded",
        "flux.severity": "unknown",
      });
      expect(record.timestamp).toBeGreaterThanOrEqual(before);
      expect(record.timestamp).toBeLessThanOrEqual(after);
      expect(record.context).toBe(mockRequestContext);
    });

    it("should reject a payload without message with 400 and a WARN log", async () => {
      const payload = fullFluxPayload();
      delete payload.message;

      const response = await postEvent(payload);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Bad Request" });
      expect(mockModuleLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Webhook request rejected: route=POST / status=400 reason=invalid_payload",
        ),
      );
      expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(1);
      expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
        reason: "invalid_payload",
      });
      expect(mockRawEmit).not.toHaveBeenCalled();
      expect(mockEventsCounter.add).not.toHaveBeenCalled();
    });

    it("should reject a whitespace-only message with 400 and invalid_payload", async () => {
      const response = await postEvent({ message: "   ", reason: "Reconciled" });

      expect(response.statusCode).toBe(400);
      expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
        reason: "invalid_payload",
      });
      expect(mockRawEmit).not.toHaveBeenCalled();
    });

    it("should accept a missing reason with 200 and default it to unknown", async () => {
      const payload = fullFluxPayload();
      delete payload.reason;

      const response = await postEvent(payload);

      expect(response.statusCode).toBe(200);
      const record = mockRawEmit.mock.calls[0][0];
      expect(record.attributes["flux.reason"]).toBe("unknown");
      expect(record.body).toBe(
        "production-us-east-1: unknown - Deployment my-app applied successfully",
      );
    });

    it("should accept a whitespace-only reason with 200 and default it to unknown", async () => {
      const payload = fullFluxPayload();
      payload.reason = "   ";

      const response = await postEvent(payload);

      expect(response.statusCode).toBe(200);
      const record = mockRawEmit.mock.calls[0][0];
      expect(record.attributes["flux.reason"]).toBe("unknown");
      expect(record.body).toBe(
        "production-us-east-1: unknown - Deployment my-app applied successfully",
      );
    });

    it("should reject an empty object payload with 400", async () => {
      const response = await postEvent({});

      expect(response.statusCode).toBe(400);
      expect(mockRawEmit).not.toHaveBeenCalled();
      expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
        reason: "invalid_payload",
      });
    });

    it("should bound the payload excerpt of a large rejected body", async () => {
      const response = await postEvent({ extra: "x".repeat(50_000) });

      expect(response.statusCode).toBe(400);
      const warning = mockModuleLogger.warn.mock.calls[0][0] as string;
      expect(warning.length).toBeLessThan(400);
      expect(warning).toContain(
        "Webhook request rejected: route=POST / status=400 reason=invalid_payload",
      );
    });

    it("should truncate a message longer than 16 KiB and flag it", async () => {
      const longMessage = "x".repeat(16 * 1024 + 1);
      const response = await postEvent({
        message: longMessage,
        reason: "Reconciled",
      });

      expect(response.statusCode).toBe(200);
      const record = mockRawEmit.mock.calls[0][0];
      const expectedMessage = "x".repeat(16 * 1024);
      expect(record.attributes["flux.message.truncated"]).toBe(true);
      expect(record.body).toBe(`unknown: Reconciled - ${expectedMessage}`);
    });

    it("should not flag a message of exactly 16 KiB", async () => {
      const message = "x".repeat(16 * 1024);
      const response = await postEvent({ message, reason: "Reconciled" });

      expect(response.statusCode).toBe(200);
      const record = mockRawEmit.mock.calls[0][0];
      expect(record.attributes["flux.message.truncated"]).toBeUndefined();
      expect(record.body).toBe(`unknown: Reconciled - ${message}`);
    });

    it("should truncate reason and cluster to 256 characters everywhere", async () => {
      const longReason = "r".repeat(300);
      const longCluster = "c".repeat(300);
      const response = await postEvent({
        message: "Deployment applied",
        reason: longReason,
        metadata: { cluster: longCluster },
      });

      expect(response.statusCode).toBe(200);
      const record = mockRawEmit.mock.calls[0][0];
      const truncatedReason = "r".repeat(256);
      const truncatedCluster = "c".repeat(256);
      expect(record.attributes["flux.reason"]).toBe(truncatedReason);
      expect(record.attributes["flux.cluster"]).toBe(truncatedCluster);
      expect(record.body).toBe(
        `${truncatedCluster}: ${truncatedReason} - Deployment applied`,
      );
      expect(mockEventsCounter.add).toHaveBeenCalledWith(1, {
        cluster: "c".repeat(64),
        reason: "r".repeat(64),
        severity: "unknown",
      });
    });

    describe("timestamp handling", () => {
      function recordTimestamp(): number {
        return mockRawEmit.mock.calls[0][0].timestamp as number;
      }

      it("should keep a valid RFC3339 timestamp", async () => {
        await postEvent({
          message: "ok",
          reason: "Reconciled",
          timestamp: "2026-10-15T12:30:00+02:00",
        });

        expect(recordTimestamp()).toBe(
          Date.parse("2026-10-15T12:30:00+02:00"),
        );
      });

      it.each([
        ["a number", 123],
        ["a pre-2000 date", "1999-12-31T23:59:59Z"],
        ["a malformed string", "not-a-date"],
        ["a non-RFC3339 string", "2026-10-15 10:00:00"],
      ])("should fall back to receipt time for %s", async (_label, timestamp) => {
        const before = Date.now();
        await postEvent({ message: "ok", reason: "Reconciled", timestamp });
        const after = Date.now();

        expect(recordTimestamp()).toBeGreaterThanOrEqual(before);
        expect(recordTimestamp()).toBeLessThanOrEqual(after);
      });

      it("should fall back to receipt time for a date more than an hour in the future", async () => {
        const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        const before = Date.now();
        await postEvent({ message: "ok", reason: "Reconciled", timestamp: future });
        const after = Date.now();

        expect(recordTimestamp()).toBeGreaterThanOrEqual(before);
        expect(recordTimestamp()).toBeLessThanOrEqual(after);
      });
    });

    describe("revision selection", () => {
      it("should prefer the kustomize revision when several controllers contribute", async () => {
        await postEvent({
          message: "ok",
          reason: "Reconciled",
          metadata: {
            "helm.toolkit.fluxcd.io/revision": "helm@1",
            "source.toolkit.fluxcd.io/revision": "source@1",
            "kustomize.toolkit.fluxcd.io/revision": "kustomize@1",
            "notification.toolkit.fluxcd.io/revision": "notification@1",
          },
        });

        expect(mockRawEmit.mock.calls[0][0].attributes["flux.revision"]).toBe(
          "kustomize@1",
        );
      });

      it("should prefer the helm revision when kustomize is absent", async () => {
        await postEvent({
          message: "ok",
          reason: "Reconciled",
          metadata: {
            "source.toolkit.fluxcd.io/revision": "source@1",
            "helm.toolkit.fluxcd.io/revision": "helm@1",
          },
        });

        expect(mockRawEmit.mock.calls[0][0].attributes["flux.revision"]).toBe(
          "helm@1",
        );
      });

      it("should pick the alphabetically first unknown revision key", async () => {
        await postEvent({
          message: "ok",
          reason: "Reconciled",
          metadata: {
            "zeta.example.com/revision": "zeta@1",
            "alpha.example.com/revision": "alpha@1",
          },
        });

        expect(mockRawEmit.mock.calls[0][0].attributes["flux.revision"]).toBe(
          "alpha@1",
        );
      });

      it("should ignore non-string and empty revision values", async () => {
        await postEvent({
          message: "ok",
          reason: "Reconciled",
          metadata: {
            "kustomize.toolkit.fluxcd.io/revision": 42,
            "source.toolkit.fluxcd.io/revision": "",
          },
        });

        expect(mockRawEmit.mock.calls[0][0].attributes).not.toHaveProperty(
          "flux.revision",
        );
      });
    });

    describe("trace correlation attributes", () => {
      it("should expose trace.id and span.id attributes for otel-light", async () => {
        mockRequestSpan.mockReturnValueOnce({
          spanContext: () => ({
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "b7ad6b7169203331",
          }),
        });

        await postEvent(fullFluxPayload());

        const record = mockRawEmit.mock.calls[0][0];
        expect(record.attributes["trace.id"]).toBe(
          "0af7651916cd43dd8448eb211c80319c",
        );
        expect(record.attributes["span.id"]).toBe("b7ad6b7169203331");
        expect(record.context).toBe(mockRequestContext);
      });

      it("should emit the event without trace attributes when no span exists", async () => {
        mockRequestSpan.mockReturnValueOnce(undefined);

        const response = await postEvent(fullFluxPayload());

        expect(response.statusCode).toBe(200);
        const record = mockRawEmit.mock.calls[0][0];
        expect(record.attributes).not.toHaveProperty("trace.id");
        expect(record.attributes).not.toHaveProperty("span.id");
      });
    });

    describe("with WEBHOOK_AUTHORIZATION_HEADER configured", () => {
      beforeEach(() => {
        config = buildConfig({ WEBHOOK_AUTHORIZATION_HEADER: "Bearer s3cr3t" });
        fastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
        registerRoutes(fastify, config);
      });

      it("should accept a request with the expected Authorization header", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/",
          headers: { authorization: "Bearer s3cr3t" },
          payload: fullFluxPayload(),
        });

        expect(response.statusCode).toBe(200);
        expect(mockEventsCounter.add).toHaveBeenCalledTimes(1);
      });

      it("should reject a request with a wrong Authorization header with 401", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/",
          headers: { authorization: "Bearer wrong" },
          payload: fullFluxPayload(),
        });

        expect(response.statusCode).toBe(401);
        expect(response.headers["www-authenticate"]).toBe("Bearer");
        expect(response.json()).toEqual({ error: "Unauthorized" });
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(1);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "unauthorized",
        });
        expect(mockRawEmit).not.toHaveBeenCalled();
        expect(mockEventsCounter.add).not.toHaveBeenCalled();
      });

      it("should reject an equal-length wrong Authorization header with 401", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/",
          headers: { authorization: "Bearer s3cr3X" },
          payload: fullFluxPayload(),
        });

        expect(response.statusCode).toBe(401);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(1);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "unauthorized",
        });
      });

      it("should reject a request without an Authorization header with 401", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/",
          payload: fullFluxPayload(),
        });

        expect(response.statusCode).toBe(401);
        expect(response.headers["www-authenticate"]).toBe("Bearer");
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(1);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "unauthorized",
        });
      });
    });

    describe("parser-level rejections", () => {
      it("should count invalid JSON once and log without the raw body", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/",
          headers: { "content-type": "application/json" },
          payload: '{"message": "secret-body-text"',
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(1);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "invalid_json",
        });
        expect(mockModuleLogger.warn).toHaveBeenCalledTimes(1);
        const warning = mockModuleLogger.warn.mock.calls[0][0] as string;
        expect(warning).toContain("route=POST /");
        expect(warning).toContain("status=400");
        expect(warning).toContain("reason=invalid_json");
        expect(warning).not.toContain("secret-body-text");
      });

      it("should count a body over 64 KiB once as payload_too_large", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/",
          headers: { "content-type": "text/plain" },
          payload: "x".repeat(64 * 1024 + 1),
        });

        expect(response.statusCode).toBe(413);
        expect(response.json().code).toBe("FST_ERR_CTP_BODY_TOO_LARGE");
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(1);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "payload_too_large",
        });
        expect(mockModuleLogger.warn).toHaveBeenCalledTimes(1);
      });

      it("should count an unsupported content type once", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/",
          headers: { "content-type": "application/xml" },
          payload: "<event/>",
        });

        expect(response.statusCode).toBe(415);
        expect(response.json().code).toBe("FST_ERR_CTP_INVALID_MEDIA_TYPE");
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(1);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "unsupported_media_type",
        });
      });

      it("should count an unknown route once and preserve the default 404 body", async () => {
        const response = await fastify.inject({ method: "GET", url: "/nope" });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          message: "Route GET:/nope not found",
          error: "Not Found",
          statusCode: 404,
        });
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(1);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "bad_request",
        });
        expect(mockModuleLogger.warn).toHaveBeenCalledTimes(1);
      });
    });

    describe("rate limiting", () => {
      it("should return 429 beyond the configured rate and count once per rejection", async () => {
        config = buildConfig({ WEBHOOK_RATE_LIMIT_PER_MINUTE: 2 });
        fastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
        registerRoutes(fastify, config);

        const first = await postEvent(fullFluxPayload());
        const second = await postEvent(fullFluxPayload());
        const third = await postEvent(fullFluxPayload());
        const fourth = await postEvent(fullFluxPayload());

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(third.statusCode).toBe(429);
        expect(third.json()).toEqual({ error: "Too Many Requests" });
        expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
        expect(fourth.statusCode).toBe(429);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledTimes(2);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "rate_limited",
        });
        expect(mockEventsCounter.add).toHaveBeenCalledTimes(2);
      });

      it("should disable rate limiting when configured with 0", async () => {
        config = buildConfig({ WEBHOOK_RATE_LIMIT_PER_MINUTE: 0 });
        fastify = Fastify({ logger: false, ...FASTIFY_OPTIONS });
        registerRoutes(fastify, config);

        for (let i = 0; i < 5; i++) {
          const response = await postEvent(fullFluxPayload());
          expect(response.statusCode).toBe(200);
        }
        expect(mockEventsCounter.add).toHaveBeenCalledTimes(5);
        expect(mockRejectedEventsCounter.add).not.toHaveBeenCalled();
      });
    });

    describe("failure accounting", () => {
      it("should not count a 500 as a rejected event", async () => {
        fastify.get("/boom", async () => {
          throw new Error("boom");
        });

        const response = await fastify.inject({ method: "GET", url: "/boom" });

        expect(response.statusCode).toBe(500);
        expect(mockRejectedEventsCounter.add).not.toHaveBeenCalled();
        expect(mockModuleLogger.error).toHaveBeenCalledTimes(1);
      });
    });

    describe("bounded metric attributes", () => {
      it("should normalize an unusual reason for metrics but keep the raw log value", async () => {
        await postEvent({
          message: "ok",
          reason: "  Reconciled/OK (v2)!! ",
          metadata: { cluster: "Prod Cluster/EU" },
        });

        const record = mockRawEmit.mock.calls[0][0];
        expect(record.attributes["flux.reason"]).toBe("Reconciled/OK (v2)!!");
        expect(record.attributes["flux.cluster"]).toBe("Prod Cluster/EU");
        expect(mockEventsCounter.add).toHaveBeenCalledWith(1, {
          cluster: "Prod_Cluster_EU",
          reason: "reconciled_ok_v2",
          severity: "unknown",
        });
      });

      it("should map an arbitrary severity to unknown for metrics only", async () => {
        const payload = fullFluxPayload();
        payload.severity = "critical";

        await postEvent(payload);

        const record = mockRawEmit.mock.calls[0][0];
        expect(record.attributes["flux.severity"]).toBe("critical");
        expect(mockEventsCounter.add).toHaveBeenCalledWith(1, {
          cluster: "production-us-east-1",
          reason: "reconciliationsucceeded",
          severity: "unknown",
        });
      });

      it("should bound long reason and cluster metric values to 64 characters", async () => {
        await postEvent({
          message: "ok",
          reason: "R".repeat(300),
          metadata: { cluster: "C".repeat(300) },
        });

        const attributes = mockEventsCounter.add.mock.calls[0][1];
        expect(attributes.reason).toHaveLength(64);
        expect(attributes.cluster).toHaveLength(64);
        expect(attributes.reason).toMatch(/^[a-z0-9_.:-]+$/);
        expect(attributes.cluster).toMatch(/^[A-Za-z0-9_.:-]+$/);
      });

      it("should reuse the same metric series for identical events", async () => {
        await postEvent(fullFluxPayload());
        await postEvent(fullFluxPayload());

        expect(mockEventsCounter.add).toHaveBeenCalledTimes(2);
        expect(mockEventsCounter.add.mock.calls[0][1]).toEqual(
          mockEventsCounter.add.mock.calls[1][1],
        );
      });
    });
  });
});
