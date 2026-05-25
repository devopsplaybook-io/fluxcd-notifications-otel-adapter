// Mock external OTel utils before importing
const mockStartSpan = jest.fn() as jest.Mock<() => { end: () => void }>;
const mockCreateCounter = jest.fn();

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardLogger: jest.fn().mockImplementation(() => ({
    createModuleLogger: jest.fn(),
    initOTel: jest.fn(),
    getLogger: jest.fn(),
  })),
  StandardTracer: jest.fn().mockImplementation(() => ({
    startSpan: mockStartSpan,
  })),
  StandardMeter: jest.fn().mockImplementation(() => ({
    createCounter: mockCreateCounter,
  })),
}));

import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import {
  OTelSetTracer,
  OTelTracer,
  OTelSetMeter,
  OTelMeter,
  OTelLogger,
  OTelRequestSpan,
} from "./OTelContext";

describe("OTelContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("OTelLogger", () => {
    it("should create a new StandardLogger on first call", () => {
      const logger = OTelLogger();
      expect(logger).toBeDefined();
      expect(logger.createModuleLogger).toBeDefined();
      expect(logger.initOTel).toBeDefined();
      expect(logger.getLogger).toBeDefined();
    });

    it("should return the same logger instance on subsequent calls", () => {
      const logger1 = OTelLogger();
      const logger2 = OTelLogger();
      expect(logger1).toBe(logger2);
    });
  });

  describe("OTelSetTracer / OTelTracer", () => {
    it("should set and retrieve a tracer", () => {
      const tracer = new StandardTracer({
        SERVICE_ID: "test",
        VERSION: "1",
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
        OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
        OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
        OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_AWS: false,
        OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
      });
      OTelSetTracer(tracer);
      expect(OTelTracer()).toBe(tracer);
    });

    it("should overwrite a previously set tracer", () => {
      const tracer1 = new StandardTracer({
        SERVICE_ID: "test",
        VERSION: "1",
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
        OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
        OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
        OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_AWS: false,
        OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
      });
      const tracer2 = new StandardTracer({
        SERVICE_ID: "test2",
        VERSION: "2",
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
        OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
        OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
        OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_AWS: false,
        OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
      });
      OTelSetTracer(tracer1);
      OTelSetTracer(tracer2);
      expect(OTelTracer()).toBe(tracer2);
    });
  });

  describe("OTelSetMeter / OTelMeter", () => {
    it("should set and retrieve a meter", () => {
      const meter = new StandardMeter({
        SERVICE_ID: "test",
        VERSION: "1",
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
        OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
        OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
        OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_AWS: false,
        OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
      });
      OTelSetMeter(meter);
      expect(OTelMeter()).toBe(meter);
    });

    it("should overwrite a previously set meter", () => {
      const meter1 = new StandardMeter({
        SERVICE_ID: "test",
        VERSION: "1",
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
        OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
        OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
        OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_AWS: false,
        OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
      });
      const meter2 = new StandardMeter({
        SERVICE_ID: "test2",
        VERSION: "2",
        OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
        OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
        OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
        OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 60,
        OPENTELEMETRY_COLLECTOR_AWS: false,
        OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
      });
      OTelSetMeter(meter1);
      OTelSetMeter(meter2);
      expect(OTelMeter()).toBe(meter2);
    });
  });

  describe("OTelRequestSpan", () => {
    it("should retrieve the tracerSpanApi from the request object", () => {
      const mockSpan = { end: jest.fn() };
      const req = { tracerSpanApi: mockSpan };
      expect(OTelRequestSpan(req)).toBe(mockSpan);
    });

    it("should return undefined when request has no tracerSpanApi", () => {
      const req = {};
      expect(OTelRequestSpan(req)).toBeUndefined();
    });
  });
});
