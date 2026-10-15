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
}));

// swc hoists static imports above the mock declarations, so load the module
// under test with an in-place require after jest.mock registration.
const { registerRoutes } = require("./AppRoutes");

import Fastify from "fastify";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { FluxEventPayload } from "./AppRoutes";
import type { Config } from "./Config";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    VERSION: "1.2.3",
    WEBHOOK_AUTHORIZATION_HEADER: "",
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
    fastify = Fastify({ logger: false });
    registerRoutes(fastify, config);
  });

  afterEach(async () => {
    await fastify.close();
    jest.restoreAllMocks();
  });

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
      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload: fullFluxPayload(),
      });

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
      await fastify.inject({
        method: "POST",
        url: "/",
        payload: fullFluxPayload(),
      });

      expect(mockEventsCounter.add).toHaveBeenCalledWith(1, {
        cluster: "production-us-east-1",
        reason: "ReconciliationSucceeded",
        severity: "info",
      });
      expect(mockRejectedEventsCounter.add).not.toHaveBeenCalled();
    });

    it("should log the event to the console in the module logger format", async () => {
      await fastify.inject({
        method: "POST",
        url: "/",
        payload: fullFluxPayload(),
      });

      expect(console.log).toHaveBeenCalledWith(
        "[info] [fluxcd-notifications] production-us-east-1: ReconciliationSucceeded - Deployment my-app applied successfully",
      );
    });

    it("should fall back to module logger only when no OTel logger is available", async () => {
      mockGetLogger.mockReturnValueOnce(undefined);
      const fallbackFastify = Fastify({ logger: false });
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

    it("should map error severity to OTel ERROR", async () => {
      const payload = fullFluxPayload();
      payload.severity = "error";

      await fastify.inject({ method: "POST", url: "/", payload });

      const record = mockRawEmit.mock.calls[0][0];
      expect(record.severityNumber).toBe(SeverityNumber.ERROR);
      expect(record.severityText).toBe("ERROR");
      expect(record.attributes["flux.severity"]).toBe("error");
    });

    it("should map warning severity to OTel WARN", async () => {
      const payload = fullFluxPayload();
      payload.severity = "warning";

      await fastify.inject({ method: "POST", url: "/", payload });

      const record = mockRawEmit.mock.calls[0][0];
      expect(record.severityNumber).toBe(SeverityNumber.WARN);
      expect(record.severityText).toBe("WARN");
      expect(record.attributes["flux.severity"]).toBe("warn");
    });

    it("should map an unknown severity to OTel INFO but keep the raw value as attribute", async () => {
      const payload = fullFluxPayload();
      payload.severity = "critical";

      await fastify.inject({ method: "POST", url: "/", payload });

      const record = mockRawEmit.mock.calls[0][0];
      expect(record.severityNumber).toBe(SeverityNumber.INFO);
      expect(record.severityText).toBe("INFO");
      expect(record.attributes["flux.severity"]).toBe("critical");
    });

    it("should default missing cluster to unknown instead of rejecting the event", async () => {
      const payload = fullFluxPayload();
      delete payload.metadata;

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

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

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

      expect(response.statusCode).toBe(200);
      const record = mockRawEmit.mock.calls[0][0];
      expect(record.attributes).toEqual({
        "flux.cluster": "unknown",
        "flux.reason": "ReconciliationSucceeded",
        "flux.severity": "unknown",
      });
      expect(record.timestamp).toBeUndefined();
      expect(record.context).toBe(mockRequestContext);
    });

    it("should reject a payload without message with 400 and a WARN log", async () => {
      const payload = fullFluxPayload();
      delete payload.message;

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Bad Request" });
      expect(mockModuleLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Rejected malformed Flux notification payload"),
      );
      expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
        reason: "invalid_payload",
      });
      expect(mockRawEmit).not.toHaveBeenCalled();
      expect(mockEventsCounter.add).not.toHaveBeenCalled();
    });

    it("should reject a payload without reason with 400", async () => {
      const payload = fullFluxPayload();
      delete payload.reason;

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(mockRawEmit).not.toHaveBeenCalled();
    });

    it("should reject an empty object payload with 400", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(mockRawEmit).not.toHaveBeenCalled();
      expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
        reason: "invalid_payload",
      });
    });

    describe("with WEBHOOK_AUTHORIZATION_HEADER configured", () => {
      beforeEach(() => {
        config = buildConfig({ WEBHOOK_AUTHORIZATION_HEADER: "Bearer s3cr3t" });
        fastify = Fastify({ logger: false });
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
        expect(response.json()).toEqual({ error: "Unauthorized" });
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "unauthorized",
        });
        expect(mockRawEmit).not.toHaveBeenCalled();
        expect(mockEventsCounter.add).not.toHaveBeenCalled();
      });

      it("should reject a request without an Authorization header with 401", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/",
          payload: fullFluxPayload(),
        });

        expect(response.statusCode).toBe(401);
        expect(mockRejectedEventsCounter.add).toHaveBeenCalledWith(1, {
          reason: "unauthorized",
        });
      });
    });
  });
});
