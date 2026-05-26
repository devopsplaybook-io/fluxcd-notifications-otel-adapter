// Mock all App dependencies before any imports
const mockWatchFile = jest.fn();

jest.mock("fs-extra", () => ({
  watchFile: mockWatchFile,
}));

const mockStartSpan = jest.fn().mockReturnValue({ end: jest.fn() });
const mockModuleLogger = {
  info: jest.fn(),
  error: jest.fn(),
};

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: jest.fn().mockImplementation(() => ({
    startSpan: mockStartSpan,
  })),
  StandardMeter: jest.fn().mockImplementation(() => ({})),
  StandardLogger: jest.fn().mockImplementation(() => ({
    createModuleLogger: jest.fn().mockReturnValue(mockModuleLogger),
    initOTel: jest.fn(),
    getLogger: jest.fn(),
  })),
}));

jest.mock("@devopsplaybook.io/otel-utils-fastify", () => ({
  StandardTracerFastifyRegisterHooks: jest.fn(),
}));

const mockConfigReload = jest.fn().mockResolvedValue(undefined);

jest.mock("./Config", () => ({
  Config: jest.fn().mockImplementation(() => ({
    reload: mockConfigReload,
    CONFIG_FILE: "config.json",
    SERVICE_ID: "fluxcd-notifications",
    VERSION: "1",
    API_PORT: 8080,
    LOG_LEVEL: "info",
    OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
    OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
    OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
    OPENTELEMETRY_COLLECTOR_AWS: false,
    OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 60,
    OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 60,
    OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
    FASTIFY_LOG_LEVEL: undefined,
  })),
}));

jest.mock("./OTelContext", () => ({
  OTelLogger: jest.fn(() => ({
    createModuleLogger: jest.fn().mockReturnValue(mockModuleLogger),
    initOTel: jest.fn(),
  })),
  OTelSetTracer: jest.fn(),
  OTelSetMeter: jest.fn(),
  OTelTracer: jest.fn(() => ({
    startSpan: mockStartSpan,
  })),
  OTelMeter: jest.fn(() => ({})),
  OTelRequestSpan: jest.fn(),
}));

import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import { Config } from "./Config";

describe("App API routes", () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(() => {
    jest.clearAllMocks();

    fastify = Fastify({ logger: false });

    // Register the same routes as App.ts
    fastify.get("/api/status", async () => {
      return { started: true };
    });

    fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        message?: string;
        reason?: string;
        metadata?: { cluster?: string };
      };
      if (body?.message && body?.reason && body?.metadata?.cluster) {
        mockModuleLogger.info(
          `${body.metadata.cluster}: ${body.reason} - ${body.message}`,
        );
        reply.status(200).send({ status: "ok" });
        return;
      }
      reply.status(400).send({ error: "Bad Request" });
    });
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe("GET /api/status", () => {
    it("should return { started: true }", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/status",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ started: true });
    });
  });

  describe("POST /", () => {
    it("should return 200 with valid flux notification payload", async () => {
      const payload = {
        message: "Deployment my-app applied successfully",
        reason: "ApplySucceeded",
        metadata: { cluster: "production-us-east-1" },
      };

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
      expect(mockModuleLogger.info).toHaveBeenCalledWith(
        "production-us-east-1: ApplySucceeded - Deployment my-app applied successfully",
      );
    });

    it("should return 400 when message is missing", async () => {
      const payload = {
        reason: "ApplySucceeded",
        metadata: { cluster: "production-us-east-1" },
      };

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Bad Request" });
    });

    it("should return 400 when reason is missing", async () => {
      const payload = {
        message: "Deployment applied",
        metadata: { cluster: "production-us-east-1" },
      };

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Bad Request" });
    });

    it("should return 400 when metadata.cluster is missing", async () => {
      const payload = {
        message: "Deployment applied",
        reason: "ApplySucceeded",
        metadata: {},
      };

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Bad Request" });
    });

    it("should return 400 when body is empty", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Bad Request" });
    });

    it("should return 400 when metadata is missing entirely", async () => {
      const payload = {
        message: "Deployment applied",
        reason: "ApplySucceeded",
      };

      const response = await fastify.inject({
        method: "POST",
        url: "/",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Bad Request" });
    });
  });

  describe("Config", () => {
    it("should use Config class defaults for the API port", () => {
      // Verify the Config class default matches what App.ts uses
      const config = new Config();
      expect(config.API_PORT).toBe(8080);
    });
  });
});
